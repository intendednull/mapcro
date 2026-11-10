import type { Timeline, TimelinePlayer } from "./timeline";

export interface BuildEntry {
  id: number;
  /** Seconds remaining; null means unknown, including casts with an unknown end. */
  cooldown: number | null;
  charges: number | null;
}
export interface AbilityBuildEntry extends BuildEntry {
  /** 1 unlocked, 2–4 upgrade tiers 1–3, as recorded in the timeline. */
  level: number;
}
export interface BuildAt {
  /** null means unavailable; an empty array means tracked with nothing owned/unlocked. */
  items: BuildEntry[] | null;
  abilities: AbilityBuildEntry[] | null;
}

/** A pure snapshot. Shop/cast/charge clocks use deciseconds, upgrades use seconds. */
export function buildAt(player: Pick<TimelinePlayer, "items" | "abilities" | "casts" | "charges">, t: number): BuildAt {
  const ds = t * 10;
  const casts = new Map<number, number>();
  const charges = new Map<number, number>();
  for (const [at, id, end] of player.casts ?? []) if (at <= ds) casts.set(id, end);
  for (const [at, id, count] of player.charges ?? []) if (at <= ds) charges.set(id, count);
  const entry = (id: number): BuildEntry => {
    const end = casts.get(id);
    return { id, cooldown: end == null || end === 0 ? null : Math.max(0, (end - ds) / 10), charges: charges.get(id) ?? null };
  };
  const owned = new Set<number>();
  for (const [at, id, kind] of player.items ?? []) {
    if (at > ds) continue;
    if (kind === 0) owned.add(id);
    else owned.delete(id);
  }
  const levels = new Map<number, number>();
  for (const [at, id, level] of player.abilities ?? []) if (at <= t) levels.set(id, level);
  return {
    items: player.items == null ? null : [...owned].map(entry),
    abilities: player.abilities == null ? null : [...levels].map(([id, level]) => ({ ...entry(id), level })),
  };
}

/** A kill total is unknown if any death so far lacks attribution. Never turn missing killers
 * into zero kills. An omitted slot asks for the team's total. */
export function killsAt(timeline: Pick<Timeline, "events"> | undefined, t: number, team: string, slot?: number): number | null {
  if (!timeline?.events) return null;
  const deaths = timeline.events.filter(e => e.kind === "death" && e.t <= t);
  if (deaths.some(e => !e.by)) return null;
  return deaths.filter(e => e.by!.team === team && (slot == null || e.by!.slot === slot)).length;
}
