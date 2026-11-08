// "Save as scene" from a match moment: one transaction that adds a frozen scene after the
// current one (players, souls and objectives as at t; clock = t; from a replay also ult
// cooldowns, the rift that's up, taken powerups and lane-wave splits) and, if the board's
// heroes differ from the match's, sets the roster to the match's heroes, slot by slot.

import { keyBetween } from "../core/order";
import type { Op } from "../gen/Op";
import type { RecordId } from "../gen/RecordId";
import type { Marker } from "../map/model";
import type { Slot } from "../board/state";
import type { SceneRow } from "../board/scenes";
import { clampToMap } from "../map/transform";
import { type Timeline, clockLabel, downAt, lanesAt, playersAt, sitesAt } from "./timeline";
import { LIMITS } from "../gen/limits";

export const slotKey = (team: string, slot: number) => `${team === "Amber" || team === "amber" ? "amber" : "sapphire"}-${slot}`;

/** Roster slots whose hero differs from the match's (the "Roster → match heroes" change). */
export function rosterChanges(roster: Slot[], tl: Timeline): Array<{ id: RecordId; hero: number }> {
  const byKey = new Map(tl.players.map((p) => [slotKey(p.team, p.slot), p.hero_id]));
  return roster.flatMap((s) => {
    const hero = byKey.get(slotKey(s.slot.team, s.slot.slot));
    return hero !== undefined && s.slot.hero !== hero ? [{ id: s.id, hero }] : [];
  });
}

export function matchSceneOps(
  roster: Slot[],
  scenes: SceneRow[],
  current: SceneRow | undefined,
  tl: Timeline,
  t: number,
  markers: Array<Pick<Marker, "key" | "kind" | "team" | "lane" | "at">>,
  mint: () => RecordId,
  lanes: string[] = [],
  opts: SceneOpts = {},
): { id: RecordId; ops: Op[]; order: string } {
  const i = current ? scenes.findIndex((s) => s.id === current.id) : scenes.length - 1;
  const id = mint();
  const second = Math.floor(t);
  const order = keyBetween(opts.after ?? scenes[i]?.scene.order, scenes[i + 1]?.scene.order);
  const name = opts.name ?? "Match moment";
  const scene = { name: sceneName(name, second), order, clock: second, ...(opts.source ? { source: { ...opts.source, t: second } } : {}) };
  const ops: Op[] = [{ Create: { id, record: { Scene: scene } } }];
  const at = new Map(playersAt(tl, second).map((p) => [slotKey(p.team, p.slot), p]));
  for (const s of roster) {
    const p = at.get(slotKey(s.slot.team, s.slot.slot));
    const where = p?.pos ?? p?.last;
    const pos = where ? clampToMap({ x: where.x, y: where.y }) : { x: 0, y: 0 };
    ops.push({
      Create: {
        id: mint(),
        record: {
          PlayerState: { scene: id, slot: s.id, pos, alive: p ? p.pos !== null : true, placed: !!where, souls: p?.souls ?? null, ult_cooldown: p?.ult ?? null, visible: true },
        },
      },
    });
  }
  for (const key of downAt(tl, second, markers)) ops.push({ Create: { id: mint(), record: { ObjectiveState: { scene: id, key, status: "Destroyed" } } } });
  // Only what differs from a new scene's defaults: the rift that's up (rifts default off) and
  // taken powerups (they default available).
  for (const [key, status] of sitesAt(tl, second, markers)) {
    const isRift = key.startsWith("rift:");
    if ((isRift && status === "Active") || (!isRift && status === "Destroyed")) ops.push({ Create: { id: mint(), record: { ObjectiveState: { scene: id, key, status } } } });
  }
  // A scene has one split per lane: the middle of the zipline colours' gap (spec §6b).
  for (const [lane, w] of lanesAt(tl, second)) if (lanes.length === 0 || lanes.includes(lane)) ops.push({ Create: { id: mint(), record: { Wave: { scene: id, lane, t: Math.round((w.amber + w.sapphire) / 2) } } } });
  if (opts.roster !== false) for (const c of rosterChanges(roster, tl)) ops.push({ Set: { id: c.id, value: { RosterHero: c.hero } } });
  return { id, ops, order };
}

export interface SceneOpts {
  /** The scene's name (default "Match moment"). */
  name?: string;
  /** Insert after this order key instead of after the current scene. */
  after?: string;
  /** Set the roster to the match's heroes (default true). */
  roster?: boolean;
  /** Where the scene came from (spec §6b): stored for "resume from here". */
  source?: { match_id: number; tier: string };
}

/**
 * A scene's name from a match: the event alone ("Mirage died"), the clock and the ▶ chip carry
 * the time (operator, 2026-11-08); within the schema's 24 characters.
 */
export function sceneName(label: string, _second?: number): string {
  return label.length > LIMITS.max_name ? `${label.slice(0, LIMITS.max_name - 1)}…` : label;
}

/**
 * One scene per moment, in order after the current scene: the roster is set to the match's
 * heroes once. `groups` holds each scene's ops, to be sent in transactions within the op cap.
 */
export function matchScenesOps(
  roster: Slot[],
  scenes: SceneRow[],
  current: SceneRow | undefined,
  tl: Timeline,
  moments: Array<{ t: number; name: string }>,
  markers: Array<Pick<Marker, "key" | "kind" | "team" | "lane" | "at">>,
  mint: () => RecordId,
  lanes: string[] = [],
): { ids: RecordId[]; ops: Op[]; groups: Op[][] } {
  const ids: RecordId[] = [];
  const groups: Op[][] = [];
  let after: string | undefined;
  moments.forEach((m, n) => {
    const r = matchSceneOps(roster, scenes, current, tl, m.t, markers, mint, lanes, { name: m.name, ...(after ? { after } : {}), roster: n === 0, source: sourceOf(tl) });
    ids.push(r.id);
    groups.push(r.ops);
    after = r.order;
  });
  return { ids, ops: groups.flat(), groups };
}

/** A timeline's scene source (spec §6b). */
export const sourceOf = (tl: Timeline) => ({ match_id: tl.match_id, tier: tl.tier === "replay" ? "replay" : "metadata" });
