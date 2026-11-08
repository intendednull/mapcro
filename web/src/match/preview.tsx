// The match preview the board draws over the map (Player, spec §6b), and the small ult ring.

import { Show } from "solid-js";
import { cx } from "../ui/cx";

export interface MatchPreview {
  /** By "amber-0" … "sapphire-5": the hero there and where it is (`null`: dead, hidden). */
  players: Map<string, { hero: number; pos: { x: number; y: number } | null; health?: number | null }>;
  /** Board objective keys down at this moment. */
  down: Set<string>;
  /** Replay tier: rifts and powerups at this moment, by key (absent: the board's own). */
  sites: Map<string, "Active" | "Destroyed">;
  /** Replay tier: lane splits (`Wave.t`) at this moment, by lane key. */
  waves: Map<string, number>;
  /** Replay tier, with Health on: objectives' health by key (absent: none drawn). */
  health?: Map<string, { pct: number; stage?: number }>;
}

/** A small ring: the part still on cooldown, as the HUD draws it under a portrait. */
export function UltRing(p: { left: number | null }) {
  const r = 6;
  const c = 2 * Math.PI * r;
  return (
    <svg class={cx("match-ult", p.left === 0 && "ready")} viewBox="-8 -8 16 16" data-testid="match-ult" data-ult={p.left == null ? "untracked" : String(p.left)} aria-hidden="true">
      <circle r={r} class="match-ult-bg" />
      <Show when={p.left != null && p.left > 0}>
        <circle r={r} class="match-ult-left" stroke-dasharray={`${(c * (p.left ?? 0)) / 100} ${c}`} transform="rotate(-90)" />
      </Show>
    </svg>
  );
}
