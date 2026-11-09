// The match preview the board draws over the map (Player, spec §6b), and the small ult ring.

import { Show } from "solid-js";
import { cx } from "../ui/cx";
import type { CampAt, PowerupAt, RejuvNow, RiftAt, UrnNow } from "./timeline";

export interface MatchPreview {
  /** By "amber-0" … "sapphire-5": the hero there, its player's name if known, and where it is
   * (`null`: dead, hidden). */
  players: Map<string, { hero: number; name?: string | null; pos: { x: number; y: number } | null; health?: number | null; respawn?: number | null }>;
  /** Board objective keys down at this moment. */
  down: Set<string>;
  /** Replay tier: rifts and powerups at this moment, by key (absent: the board's own). */
  sites: Map<string, "Active" | "Destroyed">;
  /** Replay tier: each lane's zipline colours at this moment, by lane key (`Wave.t`'s scale). */
  lanes: Map<string, { amber: number; sapphire: number }>;
  /** Replay tier: camps and the mid boss at this moment, by marker key. */
  camps: Map<string, CampAt>;
  /** Replay tier: each rift site at this moment, by marker key (empty: no rift data). */
  rifts?: Map<string, RiftAt>;
  /** Replay tier, format 2: each powerup site's buff or next spawn, by marker key. */
  powerups?: Map<string, PowerupAt>;
  /** Replay tier, with Health on: objectives' health by key (absent: none drawn). */
  health?: Map<string, { pct: number; stage?: number }>;
  /** Replay tier: the Soul Urn at this moment, its sites by marker key (absent: no urn data). */
  urn?: UrnNow;
  /** Replay tier, format 3: the Rejuvenators held at this moment (absent or empty: none). */
  rejuv?: RejuvNow[];
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
