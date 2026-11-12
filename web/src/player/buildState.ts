// A build column's state at playback time t (BuildColumn.tsx): the build and the calculated
// stats' input, held in memos that change only when what the column shows does. Playback moves t
// every frame, while a build changes with a buy, an upgrade, a cast or a cooldown's next second:
// without this, every open column (twelve on Tab) redrew all its items and recalculated its stats
// on every frame (#39).

import { createMemo } from "solid-js";
import { type BuildAt, type BuildEntry, buildAt } from "../match/builds";
import { type StatBuild, statBuild } from "../match/stats";
import type { TimelinePlayer } from "../match/timeline";

/** A cooldown as the column shows it: whole seconds, rounded up (`null`: none). */
const shownCooldown = (s: number | null) => (s == null || s <= 0 ? null : Math.ceil(s));

function sameEntry(a: BuildEntry & { level?: number }, b: BuildEntry & { level?: number }): boolean {
  return a.id === b.id && a.charges === b.charges && a.stacks === b.stacks && a.level === b.level && shownCooldown(a.cooldown) === shownCooldown(b.cooldown);
}

function sameEntries(a: ReadonlyArray<BuildEntry & { level?: number }> | null, b: ReadonlyArray<BuildEntry & { level?: number }> | null): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  return a.every((x, i) => sameEntry(x, b[i]!));
}

/** Whether the column would draw builds `a` and `b` the same. */
export function sameBuild(a: BuildAt, b: BuildAt): boolean {
  return sameEntries(a.items, b.items) && sameEntries(a.abilities, b.abilities);
}

const sameList = (a: readonly unknown[], b: readonly unknown[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/** Whether two stat inputs would calculate the same (match/stats.ts `statBuild`). */
export function sameStatBuild(a: StatBuild | null, b: StatBuild | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  const pa = a.pickups, pb = b.pickups;
  return (
    a.hero_id === b.hero_id && a.level === b.level && a.health_pct === b.health_pct && sameList(a.items, b.items) &&
    a.ability_tiers.length === b.ability_tiers.length && a.ability_tiers.every(([id, n], i) => id === b.ability_tiers[i]![0] && n === b.ability_tiers[i]![1]) &&
    pa.max_health === pb.max_health && pa.spirit_power === pb.spirit_power && pa.weapon_damage === pb.weapon_damage && pa.bullet_resist === pb.bullet_resist && pa.spirit_resist === pb.spirit_resist
  );
}

/** t while `visible`, else the value it last had: a hidden column reads nothing per frame, and
 * reads the current t again the moment it's shown. */
export function shownTime(visible: () => boolean, t: () => number) {
  let last: number | undefined;
  return createMemo(() => {
    if (visible() || last === undefined) last = t();
    return last;
  });
}

/** The build at t and the stats' input from it, as memos that change only with what's shown.
 * While `visible` is false the time holds still (Tab's columns stay mounted, hidden), so a hidden
 * column does no per-frame work; showing it reads t at once.
 * Call inside a component or root. */
export function buildState(player: () => TimelinePlayer, t: () => number, visible: () => boolean = () => true) {
  const time = shownTime(visible, t);
  const build = createMemo(() => buildAt(player(), time()), undefined, { equals: sameBuild });
  const statInput = createMemo(() => statBuild(player(), time(), build()), undefined, { equals: sameStatBuild });
  return { build, statInput, time };
}
