// A fallen hero and the game's small skull fade as one, driven only by replay time. No CSS
// animation: pausing, scrubbing, reduced motion and following all show the same frame.
// Unhoverable, so the brief death cue never takes a living hero's pointer.

import { Index, Show } from "solid-js";
import { worldToView } from "../map/transform";
import type { Art } from "../map/pack";
import { SKULL, TOKEN_R } from "../board/Tokens";
import type { MatchPreview } from "../match/preview";

/** `k`: the hero tokens' scale, so the fallen hero keeps exactly their on-screen size. */
export function DeathSkulls(p: { art: Art; vp: "amber" | "sapphire" | "neutral"; preview: () => MatchPreview | undefined; k: number }) {
  return (
    <g class="pl-skulls" data-testid="death-skulls">
      <Index each={p.preview()?.skulls ?? []}>
        {(s) => {
          const v = () => worldToView(s().at, p.vp);
          const hero = () => p.art.heroes.get(p.preview()?.players.get(s().slot)?.hero ?? -1);
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
              aria-hidden="true"
            >
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
