// The open rift's capture in Player (replay tier, format 3; spec §6b): a ring per team around the
// rift, filled to its capture progress at playback time t, as the game's cash-in meter fills. The
// timeline samples it twice a second; between samples it's their straight line, and a jump eases
// to the new value (spec §4a). Hovering the rift says when it gives up (player/Camps.tsx).

import { For, Show } from "solid-js";
import type { Art } from "../map/pack";
import { HUD_PX } from "../map/model";
import { mapToView } from "../map/transform";
import { easedNumber } from "../board/smooth";
import type { MatchPreview } from "../match/preview";

/** The rift's marker box (`.capture_point`, 32 × 32 HUD px); the rings sit just outside its icon. */
const RIFT_HUD_PX = 32;
/** Outer (Amber) and inner (Sapphire) radius and the stroke, as fractions of the box. */
const RING = { amber: 0.47, sapphire: 0.39, width: 0.07 } as const;

/** The team colours, citadel_base_styles.vcss team1Color / team2Color (topbar.css --t1, --t2). */
const COLOUR = { amber: "#D4860B", sapphire: "#4D75C3" } as const;

/** `mk`: the map markers' scale. */
export function RiftRings(p: { art: Art; vp: "amber" | "sapphire" | "neutral"; preview: () => MatchPreview | undefined; mk: number }) {
  const open = () => {
    const rifts = p.preview()?.rifts;
    if (!rifts) return undefined;
    for (const [key, r] of rifts) {
      if (r.state !== "active" || !r.capture) continue;
      const m = p.art.model.markers.find((x) => x.key === key);
      if (m) return { key, at: m.at, capture: r.capture };
    }
    return undefined;
  };
  return (
    <Show when={open()?.key} keyed>
      {(key) => {
        const amber = easedNumber(() => open()?.capture.amber ?? null);
        const sapphire = easedNumber(() => open()?.capture.sapphire ?? null);
        const box = () => RIFT_HUD_PX * HUD_PX * p.mk;
        const at = () => {
          const o = open();
          return o ? mapToView(o.at, p.vp) : { x: 0, y: 0 };
        };
        const rings = [
          { team: "amber" as const, v: amber, r: RING.amber },
          { team: "sapphire" as const, v: sapphire, r: RING.sapphire },
        ];
        return (
          <g
            class="pl-rift-rings"
            data-testid="rift-rings"
            data-key={key}
            data-amber={Math.round(open()?.capture.amber ?? 0)}
            data-sapphire={Math.round(open()?.capture.sapphire ?? 0)}
            data-captured={open()?.capture.captured ?? ""}
            transform={`translate(${at().x} ${at().y})`}
          >
            <For each={rings}>
              {(x) => {
                const r = () => x.r * box();
                const c = () => 2 * Math.PI * r();
                const pct = () => Math.max(0, Math.min(100, x.v() ?? 0));
                return (
                  <g class={`pl-rift-ring ${x.team}`} data-team={x.team}>
                    <circle class="pl-rift-track" r={r()} stroke-width={RING.width * box()} />
                    <Show when={pct() > 0}>
                      <circle
                        class="pl-rift-fill"
                        r={r()}
                        stroke={COLOUR[x.team]}
                        stroke-width={RING.width * box()}
                        stroke-dasharray={`${(c() * pct()) / 100} ${c()}`}
                        transform="rotate(-90)"
                      />
                    </Show>
                  </g>
                );
              }}
            </For>
          </g>
        );
      }}
    </Show>
  );
}
