// A scene's MapState: the frame its records hold, behind the interface Player's has (map-state
// spec §3, §6; phases 4–5). Static: a field changes only when a record does.
//
// Group A (rows 16–26: sight/unseen, cc, movement, lane edges, skulls) and Group B (rows 27–39:
// camps, powerups, obj_health, rift, urn, rejuv, plus closed shops under `has_camps`) are all
// decoded here behind `CAPTURED`. On a scene saved before a feature's rows, `CAPTURED` says false,
// every field stays empty, and the legacy meaning (D5) applies untouched.

import { type Accessor, createMemo, getOwner, runWithOwner } from "solid-js";
import type { More } from "../gen/More";
import type { ObjectiveStatus } from "../gen/ObjectiveStatus";
import type { PlayerState as HeroRecord } from "../gen/PlayerState";
import type { RecordId } from "../gen/RecordId";
import type { RosterSlot } from "../gen/RosterSlot";
import { ROWS } from "../gen/rows";
import { shiftEdges } from "../map/lanes";
import { type CampAt, type PowerupAt, shopsClosed, slotKey } from "../match/timeline";
import { type CapturedSnapshot, captured, holdsHealth, sceneHero } from "./build";
import {
  decodeCC, decodeCamps, decodeEdges, decodeObjHealth, decodePowerups, decodeRejuv, decodeRift, decodeSkulls, decodeUrn,
  isCampKind, isHealthKind,
} from "./codec";
import type { FrameMarkers } from "./frame";
import { type Feature, type HeroState, type LaneState, type MapState, type MarkerState, type SceneFacts, sameValue } from "./state";

/** What a scene's state is read from: its records, and what it reads from outside them. */
export interface SceneRecords {
  /** The scene's hero records. */
  heroes: Accessor<ReadonlyArray<{ state: HeroRecord }>>;
  /** The board's roster: a hero record names its slot by the slot's id. */
  roster: Accessor<ReadonlyArray<{ id: RecordId; slot: RosterSlot }>>;
  /** The scene's marker records, by marker key. */
  objectives: Accessor<ReadonlyMap<string, { status: ObjectiveStatus }>>;
  /** The scene's lane splits (and optional `more.edges`), by lane key. */
  waves: Accessor<ReadonlyMap<string, { t: number; more?: More }>>;
  /** The scene's own state (`SceneState.more`): what the snapshot holds. */
  state: Accessor<More | undefined>;
  /** The source match's names by slot ("amber-0"), while that match is loaded (D1: a match's
   * names are read from it, never stored). */
  names?: Accessor<((slot: string) => string | null | undefined) | undefined>;
  /** The tier of the match the scene was saved from (`Scene.source.tier`), if any. */
  tier?: Accessor<string | undefined>;
  /** The match second the snapshot was taken at (`Scene.source.t`, never edited). */
  frame?: Accessor<number | undefined>;
  /** The map's markers, for reverse-hashing Group B baseline rows and resolving shop guardians. */
  markers?: Accessor<FrameMarkers>;
}

type Snapshot = CapturedSnapshot & { tier: string | undefined };

/** Whether the snapshot holds each feature. Every feature has a line: checked against its
 * `has_*` flag and the snapshot's watermark (`rows`). */
const CAPTURED: { [F in Feature]-?: (snap: Snapshot) => boolean } = {
  // A hero's health is a row of its build (`health`), written with it: the replay tier's.
  health: (s) => s.builds && ROWS.health.index < s.rows && holdsHealth(s.tier),
  sight: (s) => s.sight,
  cc: (s) => s.cc,
  movement: (s) => s.movement,
  lanes: (s) => s.lanes,
  skulls: (s) => s.skulls,
  camps: (s) => s.camps,
  powerups: (s) => s.powerups,
  obj_health: (s) => s.obj_health,
  rifts: (s) => s.rifts,
  urn: (s) => s.urn,
  rejuv: (s) => s.rejuv,
};

/**
 * A scene's state from its records, by the registry. A slot with no hero record, a marker with
 * no record and a lane with no split are empty. Call inside a component or root: the memos live
 * as long as it does.
 */
export function fromScene(src: SceneRecords): MapState {
  const owner = getOwner();
  const memo = <T,>(f: () => T, equals?: (a: T, b: T) => boolean): Accessor<T> => runWithOwner(owner, () => createMemo(f, undefined, equals ? { equals } : undefined))!;
  const kept = <T,>(by: Map<string, T>, key: string, make: () => T): T => {
    let v = by.get(key);
    if (!v) by.set(key, (v = make()));
    return v;
  };
  const snap = memo((): Snapshot => ({ ...captured(src.state()), tier: src.tier?.() }), sameValue);
  const frame = () => src.frame?.() ?? 0;
  const markerList = (): FrameMarkers => src.markers?.() ?? [];
  const markerKind = memo(() => new Map(markerList().map((m) => [m.key, m.kind])));

  /** Each hero record with its roster slot, by slot key. */
  const bySlot = memo(() => {
    const slots = new Map(src.roster().map((s) => [s.id, s.slot]));
    const out = new Map<string, { rec: { state: HeroRecord }; slot: RosterSlot }>();
    for (const rec of src.heroes()) {
      const slot = slots.get(rec.state.slot);
      if (slot) out.set(slotKey(slot.team, slot.slot), { rec, slot });
    }
    return out;
  });

  const heroes = new Map<string, HeroState>();
  const hero = (key: string): HeroState =>
    kept(heroes, key, () => {
      const rec = () => bySlot().get(key)?.rec.state;
      const slot = () => bySlot().get(key)?.slot;
      const more = (k: "hero" | "name" | "health" | "unseen" | "cc" | "height" | "zipline") => rec()?.more?.[k];
      const alive = memo(() => rec()?.alive ?? false);
      /** Where its token stands; none until it is placed. */
      const place = memo(() => {
        const r = rec();
        return r?.placed ? { x: r.pos.x, y: r.pos.y } : null;
      }, sameValue);
      return {
        present: memo(() => !!rec()),
        // The scene's own hero when it holds its heroes (D2), else the roster's.
        hero: memo(() => sceneHero(snap().heroes, rec()?.more, slot()?.hero)),
        // Its own name first; then the name typed on the board, then the source match's (D1).
        name: memo(() => {
          if (!rec()) return null;
          const own = more("name");
          return (typeof own === "string" && own) || slot()?.name.trim() || src.names?.()?.(key) || null;
        }),
        alive,
        pos: memo(() => (alive() ? place() : null), sameValue),
        // A dead hero stays where it stood (D4).
        last: place,
        respawn: memo(() => (rec() && !alive() ? (rec()!.respawn ?? null) : null)),
        souls: memo(() => rec()?.souls ?? null),
        ult: memo(() => rec()?.ult_cooldown ?? null),
        // Captured with the build. Dead: none left. Alive with none stored: it was dead at the
        // frame and revived since, so full (spec §5).
        health: memo(() => {
          if (!rec() || !CAPTURED.health(snap())) return null;
          const stored = more("health");
          return alive() ? (typeof stored === "number" ? stored : 100) : 0;
        }),
        // Under `has_sight`, `unseen` (plus any pre-Retake manual `visible: false`) governs sight;
        // without `has_sight`, legacy D5 (`visible: false` faded for every viewer).
        inSight: memo(() => {
          const r = rec();
          if (!CAPTURED.sight(snap())) return r?.visible ?? true;
          return r?.more?.unseen !== true && r?.visible !== false;
        }),
        lastSeen: () => null,
        cc: memo(() => (CAPTURED.cc(snap()) ? decodeCC(more("cc")) : undefined)),
        height: memo(() => {
          if (!CAPTURED.movement(snap())) return undefined;
          const v = more("height");
          return v === 1 || v === 2 ? v : undefined;
        }),
        zipline: memo(() => CAPTURED.movement(snap()) && more("zipline") === true),
      };
    });

  // Group B baseline tables, decoded once per state/frame/markers change.
  const campsMap = memo(() => (CAPTURED.camps(snap()) ? decodeCamps(src.state()?.camps, frame(), markerList()) : new Map<string, CampAt>()));
  const powerupsMap = memo(() => (CAPTURED.powerups(snap()) ? decodePowerups(src.state()?.powerups, frame(), markerList()) : new Map<string, PowerupAt>()));
  const objHealthMap = memo(() => (CAPTURED.obj_health(snap()) ? decodeObjHealth(src.state()?.obj_health, markerList()) : new Map<string, { pct: number; stage?: number }>()));
  const riftDecoded = memo(() => (CAPTURED.rifts(snap()) ? decodeRift(src.state()?.rift, frame(), markerList()) : undefined), sameValue);
  const closedShops = memo(() => {
    if (!CAPTURED.camps(snap())) return new Set<string>();
    const down = new Set<string>();
    for (const [k, o] of src.objectives()) if (o.status === "Destroyed") down.add(k);
    return shopsClosed(down, markerList());
  });
  const urnDecoded = memo(
    () =>
      CAPTURED.urn(snap())
        ? decodeUrn(src.state()?.urn, src.state()?.urn_at, frame(), markerList(), (slot) => {
            const h = hero(slot);
            return h.pos() ?? h.last();
          })
        : undefined,
    sameValue,
  );
  const rejuvDecoded = memo(() => (CAPTURED.rejuv(snap()) ? decodeRejuv(src.state()?.rejuv, frame()) : undefined), sameValue);
  const deathsDecoded = memo(
    () =>
      CAPTURED.skulls(snap())
        ? decodeSkulls(src.state()?.skulls, frame(), (slot) => {
            const h = hero(slot);
            return { alive: h.alive(), last: h.last() };
          })
        : [],
    sameValue,
  );

  const markers = new Map<string, MarkerState>();
  const marker = (key: string): MarkerState =>
    kept(markers, key, () => {
      const status = memo(() => src.objectives().get(key)?.status);
      const kind = () => markerKind().get(key);
      const camp = memo(() => {
        const k = kind();
        return CAPTURED.camps(snap()) && k && isCampKind(k) ? (campsMap().get(key) ?? { state: "alive" as const }) : undefined;
      }, sameValue);
      const down = memo(
        () => status() === "Destroyed" || (status() === undefined && kind() === "midboss" && CAPTURED.camps(snap()) && camp()?.state !== "alive"),
      );
      const powerup = memo(() => (CAPTURED.powerups(snap()) ? powerupsMap().get(key) : undefined), sameValue);
      const rift = memo(() => {
        if (!CAPTURED.rifts(snap()) || kind() !== "koth") return undefined;
        const r = riftDecoded();
        if (!r) return undefined;
        if (r.activeKey === key) return r.active!;
        return r.activeKey !== null ? { state: "elsewhere" as const } : r.waiting;
      }, sameValue);
      return {
        status,
        down,
        site: memo(() => {
          const k = kind();
          if (k === "koth" && CAPTURED.rifts(snap())) {
            const r = riftDecoded();
            return r ? (r.activeKey === key ? ("Active" as const) : ("Destroyed" as const)) : undefined;
          }
          if (k === "urn" && CAPTURED.urn(snap())) {
            const u = urnDecoded();
            return u ? (u.delivery === key ? ("Active" as const) : ("Destroyed" as const)) : undefined;
          }
          if (k === "powerup" && CAPTURED.powerups(snap())) {
            const p = powerup();
            return p ? (p.state === "up" ? ("Active" as const) : ("Destroyed" as const)) : undefined;
          }
          if ((k === "camp" || k === "heal" || k === "crate") && CAPTURED.camps(snap())) {
            const c = camp();
            return c ? (c.state === "alive" ? ("Active" as const) : ("Destroyed" as const)) : undefined;
          }
          return undefined;
        }),
        shopClosed: memo(() => kind() === "shop" && closedShops().has(key)),
        camp,
        powerup,
        health: memo(() => {
          const k = kind();
          if (!CAPTURED.obj_health(snap()) || !k || !isHealthKind(k) || down()) return undefined;
          return objHealthMap().get(key) ?? { pct: 100 };
        }, sameValue),
        rift,
      };
    });

  const lanes = new Map<string, LaneState>();
  const lane = (key: string): LaneState =>
    kept(lanes, key, () => ({
      split: memo(() => src.waves().get(key)?.t),
      edges: memo(() => {
        if (!CAPTURED.lanes(snap())) return undefined;
        const w = src.waves().get(key);
        const raw = decodeEdges(w?.more?.edges);
        return raw && w ? shiftEdges(raw, w.t) : undefined;
      }, sameValue),
    }));

  const facts: SceneFacts = { urn: urnDecoded, rejuv: rejuvDecoded, deaths: deathsDecoded };
  return { hero, marker, lane, scene: () => facts, has: (f) => CAPTURED[f](snap()) };
}

/** What `sceneRecords` reads of the board's state (board/state.ts). */
export interface SceneBoard {
  playersIn(scene: RecordId | undefined): ReadonlyArray<{ state: HeroRecord }>;
  roster(): ReadonlyArray<{ id: RecordId; slot: RosterSlot }>;
  inScene(kind: string, scene: RecordId | undefined): ReadonlyArray<readonly [RecordId, unknown]>;
}

/** A scene's records out of the board's state, for `fromScene`. No scene: none. Call inside a
 * component or root. */
export function sceneRecords(
  board: SceneBoard,
  scene: Accessor<RecordId | undefined>,
  names?: SceneRecords["names"],
  tier?: SceneRecords["tier"],
  frame?: SceneRecords["frame"],
  markers?: SceneRecords["markers"],
): SceneRecords {
  const of = <T,>(kind: string) => board.inScene(kind, scene()).flatMap(([, r]) => (r && typeof r === "object" && kind in r ? [(r as Record<string, T>)[kind]!] : []));
  return {
    heroes: () => board.playersIn(scene()),
    roster: () => board.roster(),
    objectives: createMemo(() => new Map(of<{ key: string; status: ObjectiveStatus }>("ObjectiveState").map((o) => [o.key, { status: o.status }]))),
    waves: createMemo(() =>
      new Map(of<{ lane: string; t: number; more?: More }>("Wave").map((w) => [w.lane, { t: w.t, ...(w.more ? { more: w.more } : {}) }])),
    ),
    state: () => of<{ more?: More }>("SceneState")[0]?.more,
    ...(names ? { names } : {}),
    ...(tier ? { tier } : {}),
    ...(frame ? { frame } : {}),
    ...(markers ? { markers } : {}),
  };
}
