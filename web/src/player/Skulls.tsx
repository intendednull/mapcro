// A fallen hero and the game's small skull fade as one, driven only by replay time. No CSS
// animation: pausing, scrubbing, reduced motion and following all show the same frame.
// Unhoverable, so the brief death cue never takes a living hero's pointer; with the Select tool, a
// skull whose death has a recap is pressable and opens it (SkullRecap.tsx).

import { Index, Show } from "solid-js";
import { worldToView } from "../map/transform";
import type { Art } from "../map/pack";
import { SKULL, TOKEN_R } from "../board/Tokens";
import type { MatchPreview } from "../match/preview";

/** `k`: the hero tokens' scale, so the fallen hero keeps exactly their on-screen size. */
export function DeathSkulls(p: {
  art: Art; vp: "amber" | "sapphire" | "neutral"; preview: () => MatchPreview | undefined; k: number;
  /** Whether the death (slot "amber-0"…, its second) has a recap: its skull opens it. */
  hasRecap?: (slot: string, t: number) => boolean;
  /** A touch target's radius, in the skull's own units (phone: 44 px across on screen). */
  hit?: number | undefined;
  onOpenRecap?: (slot: string, t: number) => void;
}) {
  return (
    <g class="pl-skulls" data-testid="death-skulls">
      <Index each={p.preview()?.skulls ?? []}>
        {(s) => {
          const v = () => worldToView(s().at, p.vp);
          const hero = () => p.art.heroes.get(p.preview()?.players.get(s().slot)?.hero ?? -1);
          const recap = () => !!p.onOpenRecap && !!p.hasRecap?.(s().slot, s().t);
          return (
            <g
              class={`pl-skull ${s().team}`}
              data-testid="death-skull"
              data-slot={s().slot}
              data-t={s().t}
              data-x={s().at.x}
              data-y={s().at.y}
              opacity={s().opacity.toFixed(3)}
              transform={`translate(${v().x} ${v().y}) scale(${p.k})`}
              aria-hidden={recap() ? undefined : "true"}
              data-recap={recap() ? "" : undefined}
              role={recap() ? "button" : undefined}
              aria-label={recap() ? `${hero()?.name ?? "Hero"} death recap` : undefined}
              onClick={() => recap() && p.onOpenRecap!(s().slot, s().t)}
            >
              <Show when={recap() && p.hit}>{(r) => <circle class="pl-hit" r={Math.max(TOKEN_R, r())} />}</Show>
              <circle class="pl-fallen-body" r={TOKEN_R} />
              <Show when={hero()?.portrait}>
                {(src) => <image class="pl-fallen-portrait" href={src()} x={-TOKEN_R + 2} y={-TOKEN_R + 2} width={2 * TOKEN_R - 4} height={2 * TOKEN_R - 4} />}
              </Show>
              <circle class="pl-fallen-tint" r={TOKEN_R - 2} />
              <g class="pl-fallen-badge" transform={`translate(0 ${TOKEN_R * 0.55})`}>
                <circle r="9" />
                <Show when={p.art.images.get("death-skull")} fallback={<path d={SKULL} />}>
                  {(src) => <image class="pl-fallen-skull" href={src()} x="-8" y="-9" width="16" height="18" />}
                </Show>
              </g>
            </g>
          );
        }}
      </Index>
    </g>
  );
}
