// MapState: everything a frame holds, behind one interface (map-state spec §3, §6).
//
// A frame is four kinds of entity (a hero by slot, a marker by key, a lane by key, and the
// scene's own match-wide facts), each a flat set of fields. A field is a memo: a reader reruns
// only when the value it reads changes. It holds facts, never the viewer's choices (D9): health
// is in it whether or not Health is on, and each hero's sight whichever Vision is picked.
//
// `fromTimeline` is Player's producer: the fields rest on the frame's three clocks (frame.ts), so
// one that the timeline holds per second is computed once a second. `playerFrame` is the old
// readers' adapter: the same state as a `MatchPreview` under the viewer's choices, until the
// renderers read `MapState` themselves (phase 4, with `fromScene` giving the same interface).

import { type Accessor, createMemo, getOwner, runWithOwner } from "solid-js";
import type { MatchPreview } from "../match/preview";
import { type CampAt, type PowerupAt, type RejuvNow, type RiftAt, type Timeline, type UrnNow, markerKey, positionAt, respawnAt, riftAt, slotKey, urnAt } from "../match/timeline";
import type { CrowdControl } from "../player/cc";
import { type Skull, deathSeen, skullsAt } from "../player/skulls";
import { hasVision, seenFrom } from "../player/vision";
import { type FrameMarkers, type SecondPart, type Shown, type TenthPart, previewAt, secondPart, tenthPart } from "./frame";

type Pos = { x: number; y: number };

/** A hero at the frame, by slot ("amber-0" … "sapphire-5"). */
export interface HeroState {
  /** Whether the frame holds a hero in this slot at all (else every field is empty). */
  present: Accessor<boolean>;
  hero: Accessor<number | null>;
  /** Its player's name in the match, when the match has one. */
  name: Accessor<string | null>;
  alive: Accessor<boolean>;
  /** Where it is; `null` while dead. */
  pos: Accessor<Pos | null>;
  /** Where it last stood alive (a dead hero's place). */
  last: Accessor<Pos | null>;
  /** While dead: seconds until it respawns, when the match knows. */
  respawn: Accessor<number | null>;
  souls: Accessor<number | null>;
  /** Ult cooldown left, in percent. */
  ult: Accessor<number | null>;
  /** Health in percent (0: dead); `null` when the frame doesn't hold it. */
  health: Accessor<number | null>;
  /** Whether its enemies have it in sight. Always true in a match without sight data. */
  inSight: Accessor<boolean>;
  /** Out of its enemies' sight: where they last saw it and how many seconds ago. `null`: in
   * sight, or not seen since it last came into the match. */
  lastSeen: Accessor<{ at: Pos; ago: number } | null>;
  cc: Accessor<CrowdControl | undefined>;
  height: Accessor<number | undefined>;
  zipline: Accessor<boolean>;
}

/** A marker at the frame, by the board's marker key. */
export interface MarkerState {
  /** An objective that is down. */
  down: Accessor<boolean>;
  /** A rift or powerup site: up or not (`undefined`: the frame doesn't say). */
  site: Accessor<"Active" | "Destroyed" | undefined>;
  /** A lane shop closed, its guardian down. */
  shopClosed: Accessor<boolean>;
  camp: Accessor<CampAt | undefined>;
  powerup: Accessor<PowerupAt | undefined>;
  /** An objective's health in percent, and a patron's stage. */
  health: Accessor<{ pct: number; stage?: number } | undefined>;
  rift: Accessor<RiftAt | undefined>;
}

/** A lane at the frame, by lane key. */
export interface LaneState {
  /** The zipline colours' edges (`Wave.t`'s scale); `undefined`: the frame doesn't hold them. */
  edges: Accessor<{ amber: number; sapphire: number } | undefined>;
}

/** A death in the frame's last seconds, and whether the dead hero's enemies saw it. */
export type Death = Skull & { seen: boolean };

/** What the frame holds match-wide. */
export interface SceneFacts {
  /** The Soul Urn, its sites by marker key (`undefined`: no urn data). */
  urn: Accessor<UrnNow | undefined>;
  /** The Rejuvenators held (`undefined`: no data). */
  rejuv: Accessor<RejuvNow[] | undefined>;
  /** Deaths in the last seconds, every team's. */
  deaths: Accessor<Death[]>;
}

/** What a frame can hold beyond the heroes' places: computed by Player when its timeline has
 * the data, captured (or not) in a scene. */
export const FEATURES = ["health", "sight", "cc", "movement", "lanes", "camps", "powerups", "rifts", "urn", "rejuv"] as const;
export type Feature = (typeof FEATURES)[number];

export interface MapState {
  hero(slot: string): HeroState;
  marker(key: string): MarkerState;
  lane(key: string): LaneState;
  scene(): SceneFacts;
  /** Captured in a scene, or computed by Player. */
  has(feature: Feature): boolean;
}

/** Whether two plain values (numbers, strings, arrays and objects of them) hold the same: as
 * `Object.is` has it for each (so -0 is not 0, and NaN is NaN). */
export function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a), kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => k in b && sameValue((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

export interface StateSource {
  tl: Accessor<Timeline | undefined>;
  t: Accessor<number>;
  markers: Accessor<FrameMarkers>;
}

/** Player's state: `MapState`, and the clocks' parts whole, for readers of every hero or every
 * marker at once (the frame's adapter, the map's markers). */
export interface PlayerState extends MapState {
  /** The second's part: new when t enters a new second (`undefined`: no timeline). */
  second: Accessor<SecondPart | undefined>;
  /** The tenth's part: new when t enters a new tenth. */
  tenth: Accessor<TenthPart | undefined>;
}

/** What the timeline holds, by feature. */
export function featuresOf(m: Timeline): Record<Feature, boolean> {
  const replay = m.tier === "replay";
  const some = (f: (p: Timeline["players"][number]) => unknown) => m.players.some((p) => !!f(p));
  return {
    health: replay,
    sight: hasVision(m),
    cc: replay && some((p) => p.cc?.length),
    movement: replay && some((p) => p.height?.length || p.zipline?.length),
    lanes: !!m.zips?.length,
    camps: !!m.camps?.length,
    powerups: !!m.powerups?.length,
    rifts: !!m.rifts,
    urn: !!m.urn,
    rejuv: !!m.rejuv,
  };
}

/**
 * Player's producer: the match at `t`, each field on the slowest clock its data allows (the
 * second's part once a second, the tenth's once a tenth, places and what is counted from t each
 * frame). Entities are made when first asked and kept. Empty with no timeline. Call inside a
 * component or root: the memos live as long as it does.
 */
export function fromTimeline(src: StateSource): PlayerState {
  const owner = getOwner();
  const memo = <T,>(f: () => T, equals?: (a: T, b: T) => boolean): Accessor<T> => runWithOwner(owner, () => createMemo(f, undefined, equals ? { equals } : undefined))!;
  const kept = <T,>(by: Map<string, T>, key: string, make: () => T): T => {
    let v = by.get(key);
    if (!v) by.set(key, (v = make()));
    return v;
  };
  const second = memo(() => Math.floor(src.t()));
  const tenth = memo(() => Math.floor(src.t() * 10));
  const sec = memo(() => {
    const m = src.tl();
    return m && secondPart(m, second(), src.markers());
  });
  const ten = memo(() => {
    const m = src.tl();
    return m && tenthPart(m, (tenth() + 0.5) / 10);
  });
  const replay = () => src.tl()?.tier === "replay";
  const index = memo(() => new Map((src.tl()?.players ?? []).map((p, i) => [slotKey(p.team, p.slot), i])));
  const features = memo(() => {
    const m = src.tl();
    return m && featuresOf(m);
  });
  /** Without sight data nobody is ever out of sight. */
  const sighted = () => features()?.sight ?? false;

  const heroes = new Map<string, HeroState>();
  const hero = (slot: string): HeroState =>
    kept(heroes, slot, () => {
      const i = memo(() => index().get(slot) ?? -1);
      const sample = () => sec()?.heroes[i()];
      const player = () => src.tl()?.players[i()];
      const sight = memo(() => ten()?.sight[i()]);
      return {
        present: memo(() => i() >= 0),
        hero: memo(() => sample()?.hero_id ?? null),
        name: memo(() => sample()?.name ?? null),
        alive: memo(() => !!sample()?.pos),
        pos: memo(() => {
          const p = player();
          return p ? positionAt(p, src.t()) : null;
        }, sameValue),
        last: memo(() => sample()?.last ?? null, sameValue),
        respawn: memo(() => {
          const p = player();
          return p ? respawnAt(p, src.t()) : null;
        }),
        souls: memo(() => sample()?.souls ?? null),
        ult: memo(() => sample()?.ult ?? null),
        health: memo(() => sample()?.health ?? null),
        inSight: memo(() => !sighted() || sight() === undefined || sight() === true),
        lastSeen: memo(() => {
          const p = player(), s = sight();
          // Without sight data there is no last sight either (`s` is null).
          if (!p || s === undefined || s === true) return null;
          const seen = seenFrom(p, src.t(), s);
          return seen && !seen.seen ? { at: seen.at, ago: seen.ago } : null;
        }, sameValue),
        cc: memo(() => (replay() ? ten()?.cc[i()] : undefined), sameValue),
        height: memo(() => sec()?.movement[i()]?.height),
        zipline: memo(() => sec()?.movement[i()]?.zipline ?? false),
      };
    });

  /** The board's rift sites: only they hold a rift. */
  const riftSites = memo(() => new Set(src.markers().filter((mk) => mk.kind === "koth").map((mk) => mk.key)));
  const markers = new Map<string, MarkerState>();
  const marker = (key: string): MarkerState =>
    kept(markers, key, () => ({
      down: memo(() => sec()?.down.has(key) ?? false),
      site: memo(() => sec()?.sites.get(key)),
      shopClosed: memo(() => sec()?.shops.has(key) ?? false),
      camp: memo(() => sec()?.camps.get(key), sameValue),
      powerup: memo(() => sec()?.powerups.get(key), sameValue),
      health: memo(() => sec()?.health?.get(key), sameValue),
      rift: memo(() => {
        const m = src.tl();
        return m?.rifts && riftSites().has(key) ? riftAt(m, key, src.t(), src.markers()) : undefined;
      }, sameValue),
    }));

  const lanes = new Map<string, LaneState>();
  const lane = (key: string): LaneState => kept(lanes, key, () => ({ edges: memo(() => sec()?.lanes.get(key), sameValue) }));

  const facts: SceneFacts = {
    urn: memo(() => {
      const m = src.tl();
      return m && urnOf(m, src.t(), src.markers());
    }, sameValue),
    rejuv: memo(() => sec()?.rejuv, sameValue),
    deaths: memo(() => {
      const m = src.tl();
      if (!m) return [];
      const by = index();
      return skullsAt(m.players, src.t(), null).map((s) => ({ ...s, seen: deathSeen(m.players[by.get(s.slot)!]!, s.t) }));
    }, sameValue),
  };

  return { hero, marker, lane, scene: () => facts, has: (f) => features()?.[f] ?? false, second: sec, tenth: ten };
}

/** The urn at t with its sites by the board's marker keys (`undefined`: no urn data). */
export function urnOf(m: Timeline, t: number, markers: FrameMarkers): UrnNow | undefined {
  const u = urnAt(m, t);
  const site = (k: string | null | undefined) => (k ? (markerKey(k, markers) ?? null) : null);
  return u ? { ...u, delivery: site(u.delivery), next: u.next ? { t: u.next.t, key: site(u.next.key) ?? u.next.key } : null } : undefined;
}

const EMPTY = (): MatchPreview => ({ players: new Map(), down: new Set(), sites: new Map(), lanes: new Map(), camps: new Map(), rifts: new Map(), powerups: new Map() });

export interface FrameSource extends StateSource {
  shown: Accessor<Shown>;
  /** Whether this moment continues the last in playback (`MatchPreview.fade`). */
  fade: Accessor<boolean>;
}

/**
 * Player's frame as the old readers take it: the state's parts under the viewer's choices, as
 * one `MatchPreview`, new each frame. Empty with no timeline. Call inside a component or root.
 */
export function playerFrame(src: FrameSource, state: PlayerState = fromTimeline(src)): Accessor<MatchPreview> {
  return () => {
    const m = src.tl();
    const [s, d] = [state.second(), state.tenth()];
    return m && s && d ? previewAt(m, src.t(), src.markers(), src.shown(), src.fade(), s, d) : EMPTY();
  };
}

/** What the map's markers draw from (player/markerStates.ts): the second's part of the frame. */
export type MarkerPreview = Pick<MatchPreview, "down" | "shops" | "sites" | "camps" | "powerups" | "health">;

/**
 * The markers' part of Player's frame under the viewer's Health choice: new once a second (and
 * when Health is switched), not each frame. Empty with no timeline, as the frame is. Call
 * inside a component or root.
 */
export function markerFrame(state: PlayerState, health: Accessor<boolean>): Accessor<MarkerPreview> {
  return createMemo(() => {
    const s = state.second();
    if (!s) return EMPTY();
    return { down: s.down, shops: s.shops, sites: s.sites, camps: s.camps, powerups: s.powerups, ...(health() && s.health ? { health: s.health } : {}) };
  });
}
