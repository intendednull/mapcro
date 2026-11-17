// A scene's MapState: the frame its records hold, behind the interface Player's has (map-state
// spec §3, §6; phase 4). Static: a field changes only when a record does.
//
// What a scene stores today is its heroes (`PlayerState`: place, alive, souls, ult, sight as one
// flag, a respawn time, and in `more` its own hero (D2: once the scene holds its heroes), its
// name, and the build's health), its markers' statuses (`ObjectiveState`), one split per lane
// (`Wave`) and what its snapshot holds (`SceneState`). Everything else reads as not captured: the field is empty and `has` says no,
// so a renderer draws nothing for it and the legacy meaning applies (spec §4.5). The rows of
// phase 5 fill those fields here, one line each in `CAPTURED`.

import { type Accessor, createMemo, getOwner, runWithOwner } from "solid-js";
import type { More } from "../gen/More";
import type { ObjectiveStatus } from "../gen/ObjectiveStatus";
import type { PlayerState as HeroRecord } from "../gen/PlayerState";
import type { RecordId } from "../gen/RecordId";
import type { RosterSlot } from "../gen/RosterSlot";
import { ROWS } from "../gen/rows";
import { slotKey } from "../match/timeline";
import { captured, holdsHealth, sceneHero } from "./build";
import { type Feature, type HeroState, type LaneState, type MapState, type MarkerState, type SceneFacts, sameValue } from "./state";

/** What a scene's state is read from: its records, and what it reads from outside them. */
export interface SceneRecords {
  /** The scene's hero records. */
  heroes: Accessor<ReadonlyArray<{ state: HeroRecord }>>;
  /** The board's roster: a hero record names its slot by the slot's id. */
  roster: Accessor<ReadonlyArray<{ id: RecordId; slot: RosterSlot }>>;
  /** The scene's marker records, by marker key. */
  objectives: Accessor<ReadonlyMap<string, { status: ObjectiveStatus }>>;
  /** The scene's lane splits, by lane key. */
  waves: Accessor<ReadonlyMap<string, { t: number }>>;
  /** The scene's own state (`SceneState.more`): what the snapshot holds. */
  state: Accessor<More | undefined>;
  /** The source match's names by slot ("amber-0"), while that match is loaded (D1: a match's
   * names are read from it, never stored). */
  names?: Accessor<((slot: string) => string | null | undefined) | undefined>;
  /** The tier of the match the scene was saved from (`Scene.source.tier`), if any. */
  tier?: Accessor<string | undefined>;
}

type Snapshot = ReturnType<typeof captured> & { tier: string | undefined };

/** Whether the snapshot holds each feature. Every feature has a line: one a scene can't hold
 * yet says so here, and gets its rows in phase 5. */
const CAPTURED: { [F in Feature]-?: (snap: Snapshot) => boolean } = {
  // A hero's health is a row of its build (`health`), written with it: the replay tier's.
  // The metadata tier's is not held (Player doesn't hold it either), whatever a scene saved
  // before that was settled stored. Save and Retake ask the same (`holdsHealth`).
  health: (s) => s.builds && ROWS.health.index < s.rows && holdsHealth(s.tier),
  // One flag a hero (`visible`), set by hand: not each team's sight of it.
  sight: () => false,
  cc: () => false,
  movement: () => false,
  // One split a lane (`Wave.t`), not the colours' gap.
  lanes: () => false,
  camps: () => false,
  powerups: () => false,
  rifts: () => false,
  urn: () => false,
  rejuv: () => false,
};

const NONE = () => undefined;

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
  const snap = memo((): Snapshot => ({ ...captured(src.state()), tier: src.tier?.() }), (a, b) => a.builds === b.builds && a.heroes === b.heroes && a.rows === b.rows && a.patch === b.patch && a.tier === b.tier);
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
      const more = (k: "hero" | "name" | "health") => rec()?.more?.[k];
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
        // The legacy meaning (spec §4.5): `visible: false` is out of sight for every viewer.
        inSight: memo(() => rec()?.visible ?? true),
        lastSeen: () => null,
        cc: NONE,
        height: NONE,
        zipline: () => false,
      };
    });

  const markers = new Map<string, MarkerState>();
  const marker = (key: string): MarkerState =>
    kept(markers, key, () => {
      const status = memo(() => src.objectives().get(key)?.status);
      return {
        status,
        down: memo(() => status() === "Destroyed"),
        site: NONE,
        // A shop is never closed in a scene (spec §4.5).
        shopClosed: () => false,
        camp: NONE,
        powerup: NONE,
        health: NONE,
        rift: NONE,
      };
    });

  const lanes = new Map<string, LaneState>();
  const lane = (key: string): LaneState => kept(lanes, key, () => ({ split: memo(() => src.waves().get(key)?.t), edges: NONE }));

  const noDeaths: never[] = [];
  const facts: SceneFacts = { urn: NONE, rejuv: NONE, deaths: () => noDeaths };
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
export function sceneRecords(board: SceneBoard, scene: Accessor<RecordId | undefined>, names?: SceneRecords["names"], tier?: SceneRecords["tier"]): SceneRecords {
  const of = <T,>(kind: string) => board.inScene(kind, scene()).flatMap(([, r]) => (r && typeof r === "object" && kind in r ? [(r as Record<string, T>)[kind]!] : []));
  return {
    heroes: () => board.playersIn(scene()),
    roster: () => board.roster(),
    objectives: createMemo(() => new Map(of<{ key: string; status: ObjectiveStatus }>("ObjectiveState").map((o) => [o.key, { status: o.status }]))),
    waves: createMemo(() => new Map(of<{ lane: string; t: number }>("Wave").map((w) => [w.lane, { t: w.t }]))),
    state: () => of<{ more?: More }>("SceneState")[0]?.more,
    ...(names ? { names } : {}),
    ...(tier ? { tier } : {}),
  };
}
