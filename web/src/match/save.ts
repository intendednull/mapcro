// "Save as scene" from a match moment: one transaction that adds a frozen scene after the
// current one (players, souls and objectives as at t; clock = t) and, if the board's heroes
// differ from the match's, sets the roster to the match's heroes, slot by slot.

import { keyBetween } from "../core/order";
import type { Op } from "../gen/Op";
import type { RecordId } from "../gen/RecordId";
import type { Marker } from "../map/model";
import type { Slot } from "../board/state";
import type { SceneRow } from "../board/scenes";
import { clampToMap } from "../map/transform";
import { type Timeline, clockLabel, downAt, playersAt } from "./timeline";

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
  markers: Array<Pick<Marker, "key" | "kind" | "team" | "lane">>,
  mint: () => RecordId,
): { id: RecordId; ops: Op[] } {
  const i = current ? scenes.findIndex((s) => s.id === current.id) : scenes.length - 1;
  const id = mint();
  const second = Math.floor(t);
  const ops: Op[] = [
    {
      Create: {
        id,
        record: { Scene: { name: `Match ${tl.match_id} @ ${clockLabel(second)}`.slice(0, 24), order: keyBetween(scenes[i]?.scene.order, scenes[i + 1]?.scene.order), clock: second } },
      },
    },
  ];
  const at = new Map(playersAt(tl, second).map((p) => [slotKey(p.team, p.slot), p]));
  for (const s of roster) {
    const p = at.get(slotKey(s.slot.team, s.slot.slot));
    const where = p?.pos ?? p?.last;
    const pos = where ? clampToMap({ x: where.x, y: where.y }) : { x: 0, y: 0 };
    ops.push({
      Create: {
        id: mint(),
        record: {
          PlayerState: { scene: id, slot: s.id, pos, alive: p ? p.pos !== null : true, placed: !!where, souls: p?.souls ?? null, ult_cooldown: null, visible: true },
        },
      },
    });
  }
  for (const key of downAt(tl, second, markers)) ops.push({ Create: { id: mint(), record: { ObjectiveState: { scene: id, key, status: "Destroyed" } } } });
  for (const c of rosterChanges(roster, tl)) ops.push({ Set: { id: c.id, value: { RosterHero: c.hero } } });
  return { id, ops };
}
