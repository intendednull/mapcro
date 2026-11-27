// Paused Player MapState overlay & live-scene pause-edit op builders (GitHub #61;
// docs/specs/player-pause-edit.md).
//
// `fromPausedPlayer` wraps `fromTimeline(...)` and layers `liveScene` entity overrides on top
// ONLY when `!isPaused() === false` (i.e. paused) AND `liveScene.clock === clockSec()`. While
// playing, or while paused at a different timestamp, it passes through `fromTimeline` untouched.

import { type Accessor, createMemo, getOwner, runWithOwner } from "solid-js";
import type { Entry } from "../gen/Entry";
import type { More } from "../gen/More";
import type { ObjectiveStatus } from "../gen/ObjectiveStatus";
import type { Op } from "../gen/Op";
import type { PlayerState as HeroRecord } from "../gen/PlayerState";
import type { RecordId } from "../gen/RecordId";
import type { RosterSlot } from "../gen/RosterSlot";
import type { SceneState } from "../gen/SceneState";
import type { WorldPos } from "../gen/WorldPos";
import { shiftEdges } from "../map/lanes";
import { clampToDisc } from "../map/transform";
import { type CampAt, type PowerupAt, type Timeline, shopsClosed, slotKey } from "../match/timeline";
import { effectiveCamp } from "../player/Camps";
import {
  clearPauseOverridesOps,
  liveObjId,
  liveSceneStateId,
  liveWaveId,
  normalizeLegacyLiveOps,
} from "../player/live";
import { captured } from "./build";
import { decodeCamps, decodeDoors, decodeObjHealth, decodePowerups, decodeRift, isCampKind, isHealthKind } from "./codec";
import type { ObjHealthEntry } from "./edit";
import { type FrameMarkers, secondPart } from "./frame";
import { type Feature, type HeroState, type LaneState, type MapState, type MarkerState, type PlayerState, type SceneFacts, sameValue } from "./state";

/** Minimal board-state slice needed by `fromPausedPlayer` (satisfied by `BoardState`). */
export interface PausedBoard {
  readonly records: Record<RecordId, Entry | undefined>;
  playersIn(scene: RecordId | undefined): ReadonlyArray<{ id: RecordId; state: HeroRecord }>;
  roster(): ReadonlyArray<{ id: RecordId; slot: RosterSlot }>;
  inScene(kind: string, scene: RecordId | undefined): ReadonlyArray<readonly [RecordId, unknown]>;
}

/** Minimal mutable board-state slice for pause-edit preparation helpers. */
export interface MutablePausedBoard extends PausedBoard {
  edit(ops: Op[]): boolean;
  editSilent(ops: Op[]): boolean;
  ensure(ops: Op[]): boolean;
  rowsIn<T extends { scene: RecordId }>(kind: string, scene: RecordId | undefined): ReadonlyArray<{ id: RecordId; r: T }>;
}

/**
 * Player's paused overlay producer: passes through `base` (`fromTimeline`) untouched while playing
 * or when `liveScene.clock !== clockSec()`, and layers sparse `liveScene` overrides when paused at
 * the matching second. Call inside a component or root.
 */
export function fromPausedPlayer(
  base: PlayerState,
  board: PausedBoard,
  liveScene: Accessor<RecordId | undefined>,
  isPaused: Accessor<boolean>,
  clockSec: Accessor<number>,
  markers: Accessor<FrameMarkers>,
): MapState {
  const owner = getOwner();
  const memo = <T,>(f: () => T, equals?: (a: T, b: T) => boolean): Accessor<T> =>
    runWithOwner(owner, () => createMemo(f, undefined, equals ? { equals } : undefined))!;
  const kept = <T,>(by: Map<string, T>, key: string, make: () => T): T => {
    let v = by.get(key);
    if (!v) by.set(key, (v = make()));
    return v;
  };

  const active = memo(() => {
    if (!isPaused()) return false;
    const id = liveScene();
    if (!id) return false;
    const e = board.records[id];
    if (!e || e.deleted || !("Scene" in e.record)) return false;
    return e.record.Scene.clock === clockSec();
  });

  const bySlot = memo(() => {
    const out = new Map<string, HeroRecord>();
    if (!active()) return out;
    const slots = new Map(board.roster().map((s) => [s.id, s.slot]));
    for (const pl of board.playersIn(liveScene())) {
      const slot = slots.get(pl.state.slot);
      if (slot) out.set(slotKey(slot.team, slot.slot), pl.state);
    }
    return out;
  });

  const objectives = memo(() => {
    const out = new Map<string, ObjectiveStatus>();
    if (!active()) return out;
    for (const [, r] of board.inScene("ObjectiveState", liveScene())) {
      if (r && typeof r === "object" && "ObjectiveState" in r) {
        const o = (r as { ObjectiveState: { key: string; status: ObjectiveStatus } }).ObjectiveState;
        out.set(o.key, o.status);
      }
    }
    return out;
  });

  const waves = memo(() => {
    const out = new Map<string, { t: number; more?: More }>();
    if (!active()) return out;
    for (const [, r] of board.inScene("Wave", liveScene())) {
      if (r && typeof r === "object" && "Wave" in r) {
        const w = (r as { Wave: { lane: string; t: number; more?: More } }).Wave;
        out.set(w.lane, { t: w.t, ...(w.more ? { more: w.more } : {}) });
      }
    }
    return out;
  });

  // Plain getter (not a memo): `SceneState.more` is a Solid store proxy mutated in place by
  // `reconcile`, so caching the proxy reference in a memo would suppress updates when keys inside
  // `more` (like `has_doors` or `obj_health`) change. Downstream memos (`liveCap`, `liveDoors`,
  // `liveObjHealthMap`, etc.) read properties directly and track fine-grained updates.
  const liveStateMore = (): More | undefined => {
    if (!active()) return undefined;
    for (const [, r] of board.inScene("SceneState", liveScene())) {
      if (r && typeof r === "object" && "SceneState" in r) {
        return (r as { SceneState: { more?: More } }).SceneState.more;
      }
    }
    return undefined;
  };

  const liveCap = memo(() => captured(liveStateMore()), sameValue);
  const anySightOverride = memo(() => {
    if (!active()) return false;
    for (const rec of bySlot().values()) {
      if (typeof rec.more?.unseen === "boolean") return true;
    }
    return false;
  });

  const markerKind = memo(() => new Map(markers().map((m) => [m.key, m.kind])));
  const liveCampsMap = memo(() => (active() && liveCap().camps ? decodeCamps(liveStateMore()?.camps, clockSec(), markers()) : new Map<string, CampAt>()));
  const livePowerupsMap = memo(() => (active() && liveCap().powerups ? decodePowerups(liveStateMore()?.powerups, clockSec(), markers()) : new Map<string, PowerupAt>()));
  const liveObjHealthMap = memo(() =>
    active() && liveCap().obj_health ? decodeObjHealth(liveStateMore()?.obj_health, markers()) : new Map<string, ObjHealthEntry | null>(),
  );
  const liveRiftDecoded = memo(() => (active() && liveCap().rifts ? decodeRift(liveStateMore()?.rift, clockSec(), markers()) : undefined), sameValue);
  const liveDoors = memo(() => (active() && liveCap().doors ? decodeDoors(liveStateMore()?.doors) : undefined), sameValue);

  const closedShops = memo(() => {
    if (!active() || objectives().size === 0) return undefined;
    const mks = markers();
    const effDown = new Set<string>();
    const objs = objectives();
    for (const mk of mks) {
      const own = objs.get(mk.key);
      if (own !== undefined ? own === "Destroyed" : base.marker(mk.key).down()) effDown.add(mk.key);
    }
    return shopsClosed(effDown, mks);
  });

  const heroes = new Map<string, HeroState>();
  const hero = (key: string): HeroState =>
    kept(heroes, key, () => {
      const b = base.hero(key);
      const rec = () => (active() ? bySlot().get(key) : undefined);
      const alive = memo(() => {
        const r = rec();
        if (!r) return b.alive();
        if (!r.alive) return false;
        if (r.more?.health === 100) return true;
        return b.alive();
      });
      return {
        present: b.present,
        hero: memo(() => {
          const r = rec();
          return typeof r?.more?.hero === "number" ? r.more.hero : b.hero();
        }),
        name: memo(() => {
          const r = rec();
          return typeof r?.more?.name === "string" && r.more.name ? r.more.name : b.name();
        }),
        alive,
        pos: memo(() => {
          const r = rec();
          if (!r) return b.pos();
          if (!alive()) return null;
          if (r.placed) return { x: r.pos.x, y: r.pos.y };
          return b.pos();
        }, sameValue),
        last: memo(() => {
          const r = rec();
          if (!r) return b.last();
          if (r.placed) return { x: r.pos.x, y: r.pos.y };
          return b.last();
        }, sameValue),
        respawn: memo(() => {
          const r = rec();
          if (!r) return b.respawn();
          if (r.alive && r.more?.health === 100) return null;
          if (!r.alive) return r.respawn ?? null;
          return r.respawn ?? b.respawn();
        }),
        souls: memo(() => {
          const r = rec();
          return r?.souls != null ? r.souls : b.souls();
        }),
        ult: memo(() => {
          const r = rec();
          return r?.ult_cooldown != null ? r.ult_cooldown : b.ult();
        }),
        health: memo(() => {
          const r = rec();
          if (!r) return b.health();
          if (!r.alive) return 0;
          if (r.more?.health === 100) return 100;
          return b.health();
        }),
        inSight: memo(() => {
          const r = rec();
          if (typeof r?.more?.unseen === "boolean") return !r.more.unseen;
          return b.inSight();
        }),
        lastSeen: memo(() => {
          const r = rec();
          if (typeof r?.more?.unseen === "boolean") return null;
          return b.lastSeen();
        }, sameValue),
        cc: b.cc,
        height: b.height,
        zipline: b.zipline,
      };
    });

  const markerMap = new Map<string, MarkerState>();
  const marker = (key: string): MarkerState =>
    kept(markerMap, key, () => {
      const b = base.marker(key);
      const status = memo(() => (active() ? objectives().get(key) : undefined));
      const down = memo(() => {
        const own = status();
        return own !== undefined ? own === "Destroyed" : b.down();
      });
      const kind = () => markerKind().get(key);
      return {
        status,
        down,
        site: b.site,
        shopClosed: memo(() => {
          const cs = closedShops();
          return cs !== undefined ? cs.has(key) : b.shopClosed();
        }),
        camp: memo(() => {
          const k = kind();
          if (active() && liveCap().camps && k && isCampKind(k)) return liveCampsMap().get(key) ?? { state: "alive" as const };
          return b.camp();
        }, sameValue),
        powerup: memo(() => (active() && liveCap().powerups ? livePowerupsMap().get(key) : b.powerup()), sameValue),
        health: memo(() => {
          const k = kind();
          if (active() && liveCap().obj_health && k && isHealthKind(k)) {
            if (down()) return undefined;
            const h = liveObjHealthMap().get(key);
            if (h === undefined) return status() === "Stage2" ? { pct: 100, stage: 2 } : { pct: 100 };
            return h ?? undefined;
          }
          if (active()) {
            const own = status();
            if (own !== undefined) {
              if (own === "Destroyed") return undefined;
              if (k && isHealthKind(k) && (b.down() || base.has("obj_health"))) {
                return own === "Stage2" ? { pct: 100, stage: 2 } : { pct: 100 };
              }
            }
          }
          return b.health();
        }, sameValue),
        rift: memo(() => {
          if (active() && liveCap().rifts && kind() === "koth") {
            const r = liveRiftDecoded();
            if (!r) return undefined;
            if (r.activeKey === key) return r.active!;
            return r.activeKey !== null ? { state: "elsewhere" as const } : r.waiting;
          }
          return b.rift();
        }, sameValue),
      };
    });

  const laneMap = new Map<string, LaneState>();
  const lane = (key: string): LaneState =>
    kept(laneMap, key, () => {
      const b = base.lane(key);
      return {
        split: memo(() => {
          const w = active() ? waves().get(key) : undefined;
          return w !== undefined ? w.t : b.split();
        }),
        edges: memo(() => {
          const w = active() ? waves().get(key) : undefined;
          const raw = b.edges();
          if (w === undefined) return raw;
          return raw ? shiftEdges(raw, w.t) : undefined;
        }, sameValue),
      };
    });

  const bossKey = memo(() => markers().find((m) => m.kind === "midboss")?.key);
  const facts: SceneFacts = {
    urn: base.scene().urn,
    rejuv: base.scene().rejuv,
    bossCamp: memo(() => {
      const baseBoss = base.scene().bossCamp();
      if (!active()) return baseBoss;
      const k = bossKey();
      const own = k ? objectives().get(k) : undefined;
      return effectiveCamp(own, baseBoss);
    }, sameValue),
    deaths: memo(() => {
      const list = base.scene().deaths();
      if (!active()) return list;
      return list.filter((d) => !hero(d.slot).alive());
    }, sameValue),
    doors: memo(() => liveDoors() ?? base.scene().doors(), sameValue),
  };

  const has = (f: Feature): boolean => {
    if (base.has(f)) return true;
    if (!active()) return false;
    if (f === "sight" && anySightOverride()) return true;
    const cap = liveCap();
    switch (f) {
      case "sight": return cap.sight;
      case "cc": return cap.cc;
      case "movement": return cap.movement;
      case "lanes": return cap.lanes;
      case "skulls": return cap.skulls;
      case "camps": return cap.camps;
      case "powerups": return cap.powerups;
      case "obj_health": return cap.obj_health;
      case "rifts": return cap.rifts;
      case "urn": return cap.urn;
      case "rejuv": return cap.rejuv;
      case "doors": return cap.doors;
      case "health": return false;
    }
  };

  return { hero, marker, lane, scene: () => facts, has };
}

// ---- Pause-edit transaction preparation & op builders ----

/**
 * Prepare `liveSceneId` before applying a pause-edit mutation at integer `clock`:
 * 1. If another timestamp left overrides on `liveScene` (`clock != null && clock !== target`),
 *    silently clear them first so overrides from two match moments never mix (spec §2.1).
 * 2. If `liveScene.clock === null` and untouched legacy `PlayerState` records still have
 *    `placed: true, pos: {0,0}`, normalize them silently to `placed: false` (spec §2.2).
 */
export function prepareLivePauseEdit(board: MutablePausedBoard, liveSceneId: RecordId, clock: number): void {
  const sc = board.records[liveSceneId];
  if (!sc || sc.deleted || !("Scene" in sc.record)) return;
  const curClock = sc.record.Scene.clock ?? null;
  if (curClock !== null && curClock !== clock) {
    for (const tx of clearPauseOverridesOps(board.records, liveSceneId)) board.editSilent(tx);
  }
  const after = board.records[liveSceneId];
  if (after && !after.deleted && "Scene" in after.record && after.record.Scene.clock == null) {
    const norm = normalizeLegacyLiveOps(board.records, liveSceneId);
    if (norm.length) board.editSilent(norm);
  }
}

/** `SceneClock` stamp op if `liveSceneId` is not already stamped to `clock`. */
export function pauseClockOps(records: Record<RecordId, Entry | undefined>, liveSceneId: RecordId, clock: number): Op[] {
  const sc = records[liveSceneId];
  if (!sc || sc.deleted || !("Scene" in sc.record)) return [];
  return sc.record.Scene.clock === clock ? [] : [{ Set: { id: liveSceneId, value: { SceneClock: clock } } }];
}

/** Move one or more heroes on `liveScene` while paused (stamping `SceneClock` + `PlayerPlaced: true` + `PlayerPos`). */
export function pauseMoveOps(
  records: Record<RecordId, Entry | undefined>,
  liveSceneId: RecordId,
  clock: number,
  moves: ReadonlyArray<{ id: RecordId; pos: WorldPos }>,
): Op[] {
  if (!moves.length) return [];
  const ops: Op[] = [...pauseClockOps(records, liveSceneId, clock)];
  for (const { id, pos } of moves) {
    const clamped = clampToDisc(pos);
    const e = records[id];
    const ps = e && !e.deleted && "PlayerState" in e.record ? e.record.PlayerState : undefined;
    if (!ps?.placed) ops.push({ Set: { id, value: { PlayerPlaced: true } } });
    if (!ps || ps.pos.x !== clamped.x || ps.pos.y !== clamped.y) {
      ops.push({ Set: { id, value: { PlayerPos: clamped } } });
    }
  }
  return ops;
}

/** Kill a hero while paused (`PlayerAlive: false`, `PlayerPlaced: true`, `PlayerPos: curPos`, clear `more.health`). */
export function pauseKillOps(
  records: Record<RecordId, Entry | undefined>,
  liveSceneId: RecordId,
  clock: number,
  pl: { id: RecordId; state: HeroRecord },
  curPos: WorldPos,
): Op[] {
  const pos = clampToDisc(curPos);
  const ops: Op[] = [...pauseClockOps(records, liveSceneId, clock)];
  if (pl.state.alive) ops.push({ Set: { id: pl.id, value: { PlayerAlive: false } } });
  if (!pl.state.placed) ops.push({ Set: { id: pl.id, value: { PlayerPlaced: true } } });
  if (pl.state.pos.x !== pos.x || pl.state.pos.y !== pos.y) ops.push({ Set: { id: pl.id, value: { PlayerPos: pos } } });
  if (pl.state.more?.health !== undefined) ops.push({ Set: { id: pl.id, value: { More: { key: "health", value: null } } } });
  return ops;
}

/** Revive a hero while paused (`PlayerAlive: true`, `PlayerPlaced: true`, `PlayerPos: atPos`, clear respawn, `more.health: 100`). */
export function pauseReviveOps(
  records: Record<RecordId, Entry | undefined>,
  liveSceneId: RecordId,
  clock: number,
  pl: { id: RecordId; state: HeroRecord },
  atPos: WorldPos,
): Op[] {
  const pos = clampToDisc(atPos);
  const ops: Op[] = [...pauseClockOps(records, liveSceneId, clock)];
  if (!pl.state.alive) ops.push({ Set: { id: pl.id, value: { PlayerAlive: true } } });
  if (!pl.state.placed) ops.push({ Set: { id: pl.id, value: { PlayerPlaced: true } } });
  if (pl.state.pos.x !== pos.x || pl.state.pos.y !== pos.y) ops.push({ Set: { id: pl.id, value: { PlayerPos: pos } } });
  if (pl.state.respawn != null) ops.push({ Set: { id: pl.id, value: { PlayerRespawn: null } } });
  if (pl.state.more?.health !== 100) ops.push({ Set: { id: pl.id, value: { More: { key: "health", value: 100 } } } });
  return ops;
}

/** Toggle hero enemy sight while paused (`more.unseen = currentlyInSight`). */
export function pauseToggleSightOps(
  records: Record<RecordId, Entry | undefined>,
  liveSceneId: RecordId,
  clock: number,
  pl: { id: RecordId; state: HeroRecord },
  currentlyInSight: boolean,
): Op[] {
  return [
    ...pauseClockOps(records, liveSceneId, clock),
    { Set: { id: pl.id, value: { More: { key: "unseen", value: currentlyInSight } } } },
  ];
}

/** Set a hero's respawn timer (`0..600` or `null`) while paused. */
export function pauseRespawnOps(
  records: Record<RecordId, Entry | undefined>,
  liveSceneId: RecordId,
  clock: number,
  pl: { id: RecordId; state: HeroRecord },
  s: number | null,
): Op[] {
  if (s === (pl.state.respawn ?? null)) return [];
  return [...pauseClockOps(records, liveSceneId, clock), { Set: { id: pl.id, value: { PlayerRespawn: s } } }];
}

/** Set a hero's ult cooldown (`0..100` or `null`) while paused. */
export function pauseUltOps(
  records: Record<RecordId, Entry | undefined>,
  liveSceneId: RecordId,
  clock: number,
  pl: { id: RecordId; state: HeroRecord },
  pct: number | null,
): Op[] {
  return [...pauseClockOps(records, liveSceneId, clock), { Set: { id: pl.id, value: { PlayerUltCooldown: pct } } }];
}

/** Set a hero's souls while paused. */
export function pauseSoulsOps(
  records: Record<RecordId, Entry | undefined>,
  liveSceneId: RecordId,
  clock: number,
  pl: { id: RecordId; state: HeroRecord },
  souls: number | null,
): Op[] {
  return [...pauseClockOps(records, liveSceneId, clock), { Set: { id: pl.id, value: { PlayerSouls: souls } } }];
}

/** Swap a hero on `liveScene` while paused (`more.hero`, never mutating `RosterSlot`). */
export function pauseHeroOps(
  records: Record<RecordId, Entry | undefined>,
  liveSceneId: RecordId,
  clock: number,
  pl: { id: RecordId; state: HeroRecord },
  heroId: number,
): Op[] {
  return [...pauseClockOps(records, liveSceneId, clock), { Set: { id: pl.id, value: { More: { key: "hero", value: heroId } } } }];
}

/** Rename a hero on `liveScene` while paused (`more.name`, never mutating `RosterSlot`). */
export function pauseRenameOps(
  records: Record<RecordId, Entry | undefined>,
  liveSceneId: RecordId,
  clock: number,
  pl: { id: RecordId; state: HeroRecord },
  name: string,
): Op[] {
  const trimmed = name.trim();
  const next = trimmed || null;
  if ((pl.state.more?.name ?? null) === next) return [];
  return [...pauseClockOps(records, liveSceneId, clock), { Set: { id: pl.id, value: { More: { key: "name", value: next } } } }];
}

/**
 * Deterministic tombstone-aware `ObjectiveState` upserter for `liveScene` (spec §2.3 B3):
 * mutates any already-live record in place, restores a tombstoned deterministic `liveObjId`
 * strictly before `Set`, or creates `liveObjId` if absent.
 */
export function liveObjUpsert(
  records: Record<RecordId, Entry | undefined>,
  board: string,
  matchId: number,
  liveSceneId: RecordId,
  cur: ReadonlyMap<string, { id: RecordId; status: ObjectiveStatus }>,
): (key: string, status: ObjectiveStatus) => Op[] {
  return (key, status) => {
    const existing = cur.get(key);
    if (existing) {
      return existing.status === status ? [] : [{ Set: { id: existing.id, value: { ObjectiveStatus: status } } }];
    }
    const id = liveObjId(board, matchId, key);
    if (records[id]?.deleted) {
      return [{ Restore: { id } }, { Set: { id, value: { ObjectiveStatus: status } } }];
    }
    return [{ Create: { id, record: { ObjectiveState: { scene: liveSceneId, key, status } } } }];
  };
}

/**
 * Deterministic tombstone-aware `Wave` upsert ops for `liveScene` (spec §2.3 B3).
 */
export function liveWaveUpsertOps(
  records: Record<RecordId, Entry | undefined>,
  board: string,
  matchId: number,
  liveSceneId: RecordId,
  clock: number,
  waves: ReadonlyMap<string, { id: RecordId; t: number }>,
  lane: string,
  t: number,
): Op[] {
  const clockOps = pauseClockOps(records, liveSceneId, clock);
  const existing = waves.get(lane);
  if (existing) {
    return existing.t === t ? [] : [...clockOps, { Set: { id: existing.id, value: { WavePos: t } } }];
  }
  const id = liveWaveId(board, matchId, lane);
  const entry = records[id];
  if (entry?.deleted) {
    const staleMore = "Wave" in entry.record ? Object.keys(entry.record.Wave.more ?? {}) : [];
    return [
      ...clockOps,
      { Restore: { id } },
      ...staleMore.map((key): Op => ({ Set: { id, value: { More: { key, value: null } } } })),
      { Set: { id, value: { WavePos: t } } },
    ];
  }
  return [...clockOps, { Create: { id, record: { Wave: { scene: liveSceneId, lane, t } } } }];
}

/**
 * Prepare deterministic `SceneState` on `liveSceneId` before writing a seeded `SceneState.more`
 * feature (`doors`, `obj_health`) (spec §2.3, §2.5, §4.4 M7):
 * - If a live `SceneState` already exists on `liveSceneId`, returns it with `prefix: []`.
 * - If the deterministic `liveSceneStateId` is absent, ensures an empty `{ more: {} }` record via
 *   `board.ensure(...)` (absorbing concurrent `IdTaken`) and returns `{ state: { id, more: {} }, prefix: [] }`.
 * - If the deterministic `liveSceneStateId` is tombstoned, returns `{ state: { id, more: {} }, prefix: [Restore, ...clearStaleKeys] }`
 *   so the caller's single atomic `edit([...clockOps, ...prefix, ...featureOps])` restores, scrubs
 *   stale keys, and writes the freshly seeded feature in one undoable step!
 */
export function preparePausedSceneState(
  board: MutablePausedBoard,
  boardId: string,
  matchId: number,
  liveSceneId: RecordId,
): { state: { id: RecordId; more: More }; prefix: Op[] } {
  const liveRow = board.rowsIn<SceneState>("SceneState", liveSceneId)[0];
  if (liveRow) {
    return { state: { id: liveRow.id, more: liveRow.r.more ?? {} }, prefix: [] };
  }
  const id = liveSceneStateId(boardId, matchId);
  const entry = board.records[id];
  if (!entry) {
    board.ensure([{ Create: { id, record: { SceneState: { scene: liveSceneId, more: {} } } } }]);
    const created = board.records[id];
    const more = created && !created.deleted && "SceneState" in created.record ? (created.record.SceneState.more ?? {}) : {};
    return { state: { id, more }, prefix: [] };
  }
  if (entry.deleted) {
    const staleKeys = "SceneState" in entry.record ? Object.keys(entry.record.SceneState.more ?? {}) : [];
    return {
      state: { id, more: {} },
      prefix: [
        { Restore: { id } },
        ...staleKeys.map((key): Op => ({ Set: { id, value: { More: { key, value: null } } } })),
      ],
    };
  }
  const more = "SceneState" in entry.record ? (entry.record.SceneState.more ?? {}) : {};
  return { state: { id, more }, prefix: [] };
}

/** Build the frame-seeded `obj_health` map from a replay timeline at `second` for `#55` paused editing. */
export function seedObjHealthMap(
  tl: Timeline | undefined,
  second: number,
  markers: FrameMarkers,
): Map<string, ObjHealthEntry | null> {
  const out = new Map<string, ObjHealthEntry | null>();
  if (!tl) return out;
  const sec = secondPart(tl, second, markers);
  if (!sec.health) return out;
  for (const mk of markers) {
    if (!isHealthKind(mk.kind) || sec.down.has(mk.key)) continue;
    const h = sec.health.get(mk.key);
    if (!h) continue;
    if (mk.kind === "t3") {
      if (h.pct < 100 || h.stage === 2) out.set(mk.key, { pct: h.pct, ...(h.stage !== undefined ? { stage: h.stage } : {}) });
    } else if (h.pct < 100) {
      out.set(mk.key, { pct: h.pct });
    }
  }
  return out;
}
