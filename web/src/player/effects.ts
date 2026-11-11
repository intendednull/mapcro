import type { BuildCatalog } from "../map/pack";
import type { TimelinePlayer } from "../match/timeline";

export interface ActiveEffect { id: number; source: number; stacks: number; remaining: number | null; label: string; icon: string | undefined }

/** Active recorded effects at `t`, one row per effect. An effect lasting to the replay's end
 * (`endDs`) is permanent: no countdown. Effects with neither a localised name nor an icon
 * (internal bookkeeping modifiers) are left out. */
export function effectsAt(player: Pick<TimelinePlayer, "effects">, t: number, catalog?: BuildCatalog, endDs = Infinity): ActiveEffect[] | null {
  if (player.effects == null) return null;
  const ds = t * 10;
  const rows = new Map<number, ActiveEffect & { count: number }>();
  for (const [from, to, id, source, ability, stacks] of player.effects) {
    if (!(from <= ds && ds < to)) continue;
    const effect = catalog?.records.get(id);
    const cause = catalog?.records.get(ability || effect?.ability || 0);
    const icon = effect?.icon ?? cause?.icon;
    if (!icon && (!effect || effect.label_from === "internal")) continue;
    const remaining = to >= endDs ? null : (to - ds) / 10;
    const row = rows.get(id);
    if (row) {
      row.count += 1;
      row.stacks = Math.max(row.stacks, stacks, row.count);
      if (row.remaining !== null) row.remaining = remaining === null ? null : Math.max(row.remaining, remaining);
      continue;
    }
    rows.set(id, { id, source, stacks, remaining, count: 1, icon,
      label: effect?.label ?? (cause ? `${cause.label} effect` : "Unknown effect") });
  }
  return [...rows.values()].map(({ count: _, ...e }) => e)
    .sort((a, b) => (a.remaining ?? Infinity) - (b.remaining ?? Infinity));
}
