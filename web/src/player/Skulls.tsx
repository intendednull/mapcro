// Death skulls in Player (spec §6b "Death skulls"): where each death the view saw fell, a small
// skull in the dead hero's team colour, at the opacity playback time t gives it (player/skulls.ts).
// Nothing animates: the fade is t's, so scrubbing, pausing, reduced motion and following all
// draw the same. Not hoverable: it lives a couple of seconds and must not take the pointer from
// a token beneath it.

import { Index } from "solid-js";
import { worldToView } from "../map/transform";
import { SKULL } from "../board/Tokens";
import type { MatchPreview } from "../match/preview";

/** The skull's size against the dead badge's (Tokens.tsx, r 8): ~60% of a hero token across, small
 * beside the heroes, yet a skull and not a dot at the default zoom. */
const SIZE = 1.5;

/** `k`: the hero tokens' scale, so the skull keeps its on-screen size as the map zooms. */
export function DeathSkulls(p: { vp: "amber" | "sapphire" | "neutral"; preview: () => MatchPreview | undefined; k: number }) {
  return (
    <g class="pl-skulls" data-testid="death-skulls">
      <Index each={p.preview()?.skulls ?? []}>
        {(s) => {
          // By position, not identity: each frame makes new skulls, and the elements stay.
          const v = () => worldToView(s().at, p.vp);
          return (
            <g
              class={`pl-skull ${s().team}`}
              data-testid="death-skull"
              data-slot={s().slot}
              data-t={s().t}
              data-x={s().at.x}
              data-y={s().at.y}
              opacity={s().opacity.toFixed(3)}
              transform={`translate(${v().x} ${v().y}) scale(${p.k * SIZE})`}
              aria-hidden="true"
            >
              <circle r="9" />
              <path d={SKULL} />
            </g>
          );
        }}
      </Index>
    </g>
  );
}
