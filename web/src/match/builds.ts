import { scoreboardValueAt, type Timeline, type TimelinePlayer } from "./timeline";

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

/** One row of a hero's build order: a buy (with the components it used up), a sale, a component
 * used up by an upgrade bought at another moment, or an item gone otherwise. */
export interface BuildOrderEntry {
  /** Seconds. */
  t: number;
  id: number;
  kind: "bought" | "sold" | "merged" | "removed";
  /** A buy's components that the upgrade used up (the `merged` rows at the same moment). */
  from: number[];
}

const ORDER_KINDS = ["bought", "sold", "merged", "removed"] as const;

/** The `items` series (kind 0 bought, 1 sold, 2 used up by an upgrade, 3 gone otherwise) as a
 * build order, earliest first. A component used up at the moment of a buy goes with that buy
 * (the one whose `components` list it, if known); null means the series is unavailable. */
export function buildOrder(player: Pick<TimelinePlayer, "items">, components?: (id: number) => number[] | undefined): BuildOrderEntry[] | null {
  if (player.items == null) return null;
  const rows = [...player.items].sort((a, b) => a[0] - b[0]);
  const out: BuildOrderEntry[] = [];
  const merged: BuildOrderEntry[] = [];
  for (const [ds, id, kind] of rows) {
    const entry: BuildOrderEntry = { t: ds / 10, id, kind: ORDER_KINDS[kind] ?? "removed", from: [] };
    out.push(entry);
    if (entry.kind === "merged") merged.push(entry);
  }
  const folded = new Set<BuildOrderEntry>();
  for (const m of merged) {
    const buys = out.filter(e => e.kind === "bought" && e.t === m.t);
    const buy = buys.find(b => components?.(b.id)?.includes(m.id)) ?? (components ? undefined : buys[0]);
    if (!buy) continue;
    buy.from.push(m.id);
    folded.add(m);
  }
  return out.filter(e => !folded.has(e));
}

/** A kill total is unknown if any death so far lacks attribution. Never turn missing killers
 * into zero kills. An omitted slot asks for the team's total. */
export function killsAt(timeline: (Pick<Timeline, "events"> & Partial<Pick<Timeline, "players">>) | undefined, t: number, team: string, slot?: number): number | null {
  const players = timeline?.players?.filter(p => p.team === team && (slot == null || p.slot === slot));
  if (players?.some(p => p.kills != null)) {
    const values = players.map(p => scoreboardValueAt(p.kills, t));
    return values.every(v => v != null) ? values.reduce<number>((sum, v) => sum + v!, 0) : null;
  }
  if (!timeline?.events) return null;
  const deaths = timeline.events.filter(e => e.kind === "death" && e.t <= t);
  if (deaths.some(e => !e.by)) return null;
  return deaths.filter(e => e.by!.team === team && (slot == null || e.by!.slot === slot)).length;
}
