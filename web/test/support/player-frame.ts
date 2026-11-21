// The test-only reference definition of Player's frame (`previewAt`, `MatchPreview`, TD-140)
// and helpers over Player's clocks (`fromTimeline`). The renderers read `MapState`.

import type { Accessor } from "solid-js";
import { type FrameMarkers, type SecondPart, type Shown, type TenthPart, secondPart, tenthPart } from "../../src/mapstate/frame";
import type { PlayerHero } from "../../src/mapstate/shown";
import { type PlayerState, type StateSource, fromTimeline } from "../../src/mapstate/state";
import {
  type CampAt, type PlayerAt, type PowerupAt, type RejuvNow, type RiftAt, type Timeline, type UrnNow,
  markerKey, positionAt, respawnAt, riftAt, slotKey, urnAt,
} from "../../src/match/timeline";
import { type Skull, skullsAt } from "../../src/player/skulls";
import { hasVision, seenFrom } from "../../src/player/vision";

export interface MatchPreview {
  players: Map<string, PlayerHero>;
  fade?: boolean;
  down: Set<string>;
  shops?: Set<string>;
  sites: Map<string, "Active" | "Destroyed">;
  lanes: Map<string, { amber: number; sapphire: number }>;
  camps: Map<string, CampAt>;
  rifts?: Map<string, RiftAt>;
  powerups?: Map<string, PowerupAt>;
  health?: Map<string, { pct: number; stage?: number }>;
  urn?: UrnNow & { unseen?: boolean };
  rejuv?: RejuvNow[];
  skulls?: Skull[];
}

/**
 * The match at `at` as the board draws it under the viewer's choices (reference definition for
 * `frame-clocks.test.ts` and `shown.test.ts`).
 */
export function previewAt(
  m: Timeline,
  at: number,
  markers: FrameMarkers,
  shown: Shown,
  fade: boolean,
  sec: SecondPart = secondPart(m, at, markers),
  tenth: TenthPart = tenthPart(m, at),
): MatchPreview {
  const replay = m.tier === "replay";
  const health = shown.health && replay;
  const view = shown.vision !== "all" && hasVision(m) ? shown.vision : null;
  const seen = (i: number) => seenFrom(m.players[i]!, at, tenth.sight[i]!);
  const players: MatchPreview["players"] = new Map(
    sec.heroes.map((x, i) => {
      const p = m.players[i]!;
      const pos = positionAt(p, at);
      const base = { hero: x.hero_id, name: shown.names ? x.name : null, pos, health: health ? x.health : null, respawn: respawnAt(p, at) };
      const s = view && x.team !== view ? seen(i) : { seen: true as const };
      if (s?.seen) return [slotKey(x.team, x.slot), { ...base, ...(shown.movement && replay && pos ? sec.movement[i] : {}), ...(shown.cc && replay && pos ? { cc: tenth.cc[i] } : {}) }];
      return [slotKey(x.team, x.slot), shown.lastSeen && s ? { ...base, pos: s.at, health: null, ghost: s.ago } : { ...base, pos: null, health: null, ghost: null, unseen: true }];
    }),
  );
  const u = urnAt(m, at);
  const site = (k: string | null | undefined) => (k ? (markerKey(k, markers) ?? null) : null);
  const carrier = u?.state === "carried" && view && u.team !== view ? m.players.findIndex((q) => q.team === u.team && q.slot === u.slot) : -1;
  const unseen = carrier >= 0 && !seen(carrier)?.seen;
  const urn = u ? { ...u, ...(unseen ? { at: null, unseen: true } : {}), delivery: site(u.delivery), next: u.next ? { t: u.next.t, key: site(u.next.key) ?? u.next.key } : null } : undefined;
  const rifts = new Map<string, RiftAt>();
  if (m.rifts) for (const mk of markers) if (mk.kind === "koth") rifts.set(mk.key, riftAt(m, mk.key, at, markers)!);
  const skulls = skullsAt(m.players, at, view);
  return {
    fade, skulls, players, down: sec.down, shops: sec.shops, sites: sec.sites, lanes: sec.lanes, camps: sec.camps, rifts, powerups: sec.powerups,
    ...(health ? { health: sec.health! } : {}), ...(urn ? { urn } : {}), ...(sec.rejuv ? { rejuv: sec.rejuv } : {}),
  };
}

const EMPTY = (): MatchPreview => ({ players: new Map(), down: new Set(), sites: new Map(), lanes: new Map(), camps: new Map(), rifts: new Map(), powerups: new Map() });

export interface FrameSource extends StateSource {
  shown: Accessor<Shown>;
  /** Whether this moment continues the last in playback (`MatchPreview.fade`). */
  fade: Accessor<boolean>;
}

/** Player's frame under the viewer's choices, new each frame. Empty with no timeline. Call inside
 * a component or root. */
export function playerFrame(src: FrameSource, state: PlayerState = fromTimeline(src)): Accessor<MatchPreview> {
  return () => {
    const m = src.tl();
    const [s, d] = [state.second(), state.tenth()];
    return m && s && d ? previewAt(m, src.t(), src.markers(), src.shown(), src.fade(), s, d) : EMPTY();
  };
}

/** `playersAt(m, t)` from the samples of t's second (`playersAt(m, Math.floor(t))`): a hero's
 * samples are the second's; its place and its respawn time are counted from t. The top bar's
 * heroes are this (`HeroState`'s fields, player/barSlot.ts). */
export function heroesAt(m: Timeline, t: number, samples: PlayerAt[]): PlayerAt[] {
  return samples.map((x, i) => ({ ...x, pos: positionAt(m.players[i]!, t), respawn: respawnAt(m.players[i]!, t) }));
}
