// A hero's info panel, opened by a single click on its minimap token in Player (feedback #8;
// spec §6b "Hero panel"): the Tab column's parts (BuildColumn: K/D/A, investment, stats,
// abilities with cooldowns, items) for that hero at t, with their tooltips. Several can be open,
// one per hero (#37): another token's click opens its own, or brings it to the front. Each moves
// by a drag of its top (panelPlace.ts); × closes it, Escape the front one; another match closes
// them all.
//
// Vision: in a team's view, an enemy that team can't see now shows what the scoreboard shows and
// no more: no cooldowns, charges or effects (`limited`). A hero the view doesn't draw has no token
// to click, so its panel can't open; one that leaves sight while open turns limited.

import { Show, createMemo, createResource, onCleanup, onMount } from "solid-js";
import { cx } from "../ui/cx";
import type { Art } from "../map/pack";
import { slotPlaceholder } from "../board/roster";
import { slotKey } from "../match/save";
import { ladderKeyFor, loadStatTable, tableKeyFor } from "../match/stats";
import type { Timeline } from "../match/timeline";
import { BuildColumn } from "./BuildColumn";
import { playerBuildView } from "../mapstate/buildView";
import type { MapState } from "../mapstate/state";
import { Hover, TagTip } from "./GameTooltip";
import { type Place, type Spot, movable } from "./panelPlace";
import { type Vision, hasVision } from "./vision";

export interface HeroCardSlot { team: string; slot: number }

export function HeroCard(p: {
  open: HeroCardSlot;
  timeline: Timeline;
  t: number;
  vision: Vision;
  /** The match's state at t: whether the hero is in its enemies' sight. */
  ms: MapState;
  art: Art;
  name?: ((team: string, slot: number) => string | undefined) | undefined;
  onSeek?: ((t: number) => void) | undefined;
  onClose: () => void;
  /** Where it was put (none: `home`), and its move; a press on it (to the front). */
  place: Place | undefined;
  home: Spot;
  onPlace: (at: Place) => void;
  onPress: () => void;
  /** Its stacking order among the open panels, and whether it is at the front (Escape's). */
  z: number;
  front: boolean;
  /** Whether camera tracking is currently locked onto this hero. */
  tracked?: boolean | undefined;
  /** Toggle camera tracking for this hero. */
  onTrack?: (() => void) | undefined;
  /** Phone layout: starting tracking from the card auto-closes the card so the map stays unobstructed. */
  phone?: boolean | undefined;
}) {
  const player = createMemo(() => p.timeline.players.find((q) => q.team === p.open.team && q.slot === p.open.slot));
  const hero = () => p.art.heroes.get(player()?.hero_id ?? -1);
  const view = () => (p.vision !== "all" && hasVision(p.timeline) ? p.vision : null);
  // The hero's sight is the tenth's (mapstate/state.ts): asked once a tenth, not each frame.
  const limited = () => {
    const pl = player();
    return !!pl && view() != null && pl.team !== view() && !p.ms.hero(slotKey(pl.team, pl.slot)).inSight();
  };
  const build = () => p.timeline.build;
  const [stats] = createResource(() => tableKeyFor(p.art.stats, build()) ?? false, (key) => loadStatTable(p.art.stats, key || null));
  const [ladder] = createResource(() => ladderKeyFor(p.art.stats, build()) ?? false, (key) => loadStatTable(p.art.stats, key || null));
  onMount(() => {
    // The front panel only: closing it marks the key used, so the next one stays.
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || !p.front) return;
      e.preventDefault();
      p.onClose();
    };
    window.addEventListener("keydown", key);
    onCleanup(() => window.removeEventListener("keydown", key));
  });
  // The match's name when Names shows it, else the same stand-in as the tokens and both top bars
  // ("King 1"), so the panel never opens with an empty header (feedback #50).
  const name = () => {
    const pl = player();
    return pl ? p.name?.(pl.team, pl.slot) || slotPlaceholder(pl.team, pl.slot) : undefined;
  };
  return (
    <Show when={player()}>
      {(pl) => {
        // Made once for the panel: the view's memos follow the hero and t.
        const view = playerBuildView(pl, () => p.timeline, () => p.t);
        return (
        <section
          ref={(el) => movable(el, { place: () => p.place, home: () => p.home, onPlace: (at) => p.onPlace(at), onPress: () => p.onPress(), handle: ".hero-panel-head" })}
          class="hero-panel"
          style={{ "z-index": p.z }}
          data-testid="hero-card"
          data-slot={slotKey(pl().team, pl().slot)}
          data-front={String(p.front)}
          data-limited={String(limited())}
          aria-label={hero()?.name ?? "Hero"}
        >
          <div class="hero-panel-head">
            <Show when={hero()?.portrait}>{(src) => <img src={src()} alt="" />}</Show>
            {/* The column below names the player and the hero. */}
            <span />
            <Show when={p.onTrack}>
              <Hover tip={() => <TagTip text={p.tracked ? "Stop tracking" : "Track hero"} />}>
                <button
                  type="button"
                  class={cx("btn icon small hero-panel-track", p.tracked && "active")}
                  data-testid="hero-card-track"
                  aria-label={p.tracked ? "Stop tracking" : "Track hero"}
                  aria-pressed={!!p.tracked}
                  onClick={() => {
                    const starting = !p.tracked;
                    p.onTrack!();
                    if (starting && p.phone) p.onClose();
                  }}
                >
                  <svg class="ico" viewBox="0 0 24 24" aria-hidden="true">
                    <circle cx="12" cy="12" r="5" />
                    <path d="M12 2v4M12 18v4M2 12h4M18 12h4" />
                  </svg>
                </button>
              </Hover>
            </Show>
            <Hover tip={() => <TagTip text="Close (Esc)" />}><button type="button" class="btn small" data-testid="hero-card-close" aria-label="Close" onClick={() => p.onClose()}>×</button></Hover>
          </div>
          <BuildColumn limited={limited()} view={view} art={p.art} hero={hero()} name={name()} id={`hero-card-${pl().team}-${pl().slot}`} stats={stats.latest} ladder={ladder.latest} onSeek={p.onSeek} />
        </section>
        );
      }}
    </Show>
  );
}
