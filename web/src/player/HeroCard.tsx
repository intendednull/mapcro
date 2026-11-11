// A hero's info panel, opened by a single click on its minimap token in Player (feedback #8;
// spec §6b "Hero panel"): the Tab column's parts (BuildColumn: K/D/A, investment, stats,
// abilities with cooldowns, items) for that hero at t, with their tooltips. Escape or × closes
// it; another token's click swaps it; another match closes it.
//
// Vision: in a team's view, an enemy that team can't see now shows what the scoreboard shows and
// no more: no cooldowns, charges or effects (`limited`). A hero the view doesn't draw has no token
// to click, so its panel can't open; one that leaves sight while open turns limited.

import { Show, createMemo, createResource, onCleanup, onMount } from "solid-js";
import type { Art } from "../map/pack";
import { slotKey } from "../match/save";
import { ladderKeyFor, loadStatTable, tableKeyFor } from "../match/stats";
import type { Timeline } from "../match/timeline";
import { BuildColumn } from "./BuildColumn";
import { type Vision, hasVision, seenAt } from "./vision";

export interface HeroCardSlot { team: string; slot: number }

export function HeroCard(p: { open: HeroCardSlot; timeline: Timeline; t: number; vision: Vision; art: Art; name?: ((team: string, slot: number) => string | undefined) | undefined; onSeek?: ((t: number) => void) | undefined; onClose: () => void }) {
  const player = createMemo(() => p.timeline.players.find((q) => q.team === p.open.team && q.slot === p.open.slot));
  const hero = () => p.art.heroes.get(player()?.hero_id ?? -1);
  const view = () => (p.vision !== "all" && hasVision(p.timeline) ? p.vision : null);
  const limited = () => {
    const pl = player();
    return !!pl && view() != null && pl.team !== view() && !seenAt(pl, p.t)?.seen;
  };
  const build = () => p.timeline.build;
  const [stats] = createResource(() => tableKeyFor(p.art.stats, build()) ?? false, (key) => loadStatTable(p.art.stats, key || null));
  const [ladder] = createResource(() => ladderKeyFor(p.art.stats, build()) ?? false, (key) => loadStatTable(p.art.stats, key || null));
  onMount(() => {
    const key = (e: KeyboardEvent) => { if (e.key === "Escape" && !e.defaultPrevented) p.onClose(); };
    window.addEventListener("keydown", key);
    onCleanup(() => window.removeEventListener("keydown", key));
  });
  const name = () => (player() ? p.name?.(player()!.team, player()!.slot) : undefined);
  return (
    <Show when={player()}>
      {(pl) => (
        <section class="hero-card" data-testid="hero-card" data-slot={slotKey(pl().team, pl().slot)} data-limited={String(limited())} aria-label={hero()?.name ?? "Hero"}>
          <div class="hero-card-head">
            <Show when={hero()?.portrait}>{(src) => <img src={src()} alt="" />}</Show>
            {/* The column below names the player and the hero. */}
            <span />
            <button type="button" class="btn small" data-testid="hero-card-close" aria-label="Close" title="Close (Esc)" onClick={() => p.onClose()}>×</button>
          </div>
          <BuildColumn limited={limited()} player={pl()} timeline={p.timeline} t={p.t} art={p.art} hero={hero()} name={name()} id={`hero-card-${pl().team}-${pl().slot}`} stats={stats.latest} ladder={ladder.latest} onSeek={p.onSeek} />
        </section>
      )}
    </Show>
  );
}
