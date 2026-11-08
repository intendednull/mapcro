// The Soul Urn in Player (replay tier, spec §6b): the urn where it is, on the ground or on its
// carrier (in the carrier's team colour, at the token's lower right as the HUD's held-urn image
// sits), from the match at playback time t. The delivery point is a map marker (MapView, kind
// "urn"), lit while open; hovering a point says when the next urn spawns (player/Camps.tsx).

import { Show } from "solid-js";
import { cx } from "../ui/cx";
import type { Art } from "../map/pack";
import { worldToView } from "../map/transform";
import { TOKEN_R } from "../board/Tokens";
import { type UrnNow, clockLabel } from "../match/timeline";
import type { MatchPreview } from "../match/preview";

/** The urn's size in view units at the default view: a little under a hero token's. */
const URN_PX = 30;

/** The tooltip for urn point `key` at playback time t. */
export function urnTip(u: UrnNow, key: string, t: number): string {
  if (u.delivery === key) return u.state === "carried" ? "Urn delivery point: open, urn carried" : "Urn delivery point: open";
  const n = u.next;
  // Spawned and still falling (12.5 s on 129738985): no point is open yet.
  if (u.state === "ground" && !u.delivery) return "Urn landing: its delivery point opens as it lands";
  if (u.state !== "none") return "Urn in play";
  if (!n) return "No more urns in this replay";
  const when = `in ${clockLabel(Math.max(0, Math.ceil(n.t - t)))} (at ${clockLabel(n.t)})`;
  return n.key === key ? `Urn spawns here ${when}` : `Next urn spawns at the other site ${when}`;
}

export function UrnMark(p: { art: Art; vp: "amber" | "sapphire" | "neutral"; preview: () => MatchPreview | undefined; k: number }) {
  const u = () => {
    const x = p.preview()?.urn;
    return x && x.state !== "none" && x.at ? x : undefined;
  };
  const img = () => p.art.images.get("urn");
  return (
    <Show when={u()}>
      {(x) => {
        const carried = () => x().state === "carried";
        const size = () => URN_PX * p.k * (carried() ? 0.75 : 1);
        // Carried: at the carrier token's lower right (.held_idol_image's offset).
        const at = () => {
          const v = worldToView(x().at!, p.vp);
          const off = carried() ? TOKEN_R * p.k * 0.75 : 0;
          return { x: v.x + off, y: v.y + off };
        };
        return (
          <g
            class={cx("pl-urn", `urn-${x().state}`, x().team ?? "neutral")}
            data-testid="urn"
            data-state={x().state}
            data-team={x().team ?? ""}
            data-x={Math.round(x().at!.x)}
            data-y={Math.round(x().at!.y)}
            transform={`translate(${at().x} ${at().y})`}
          >
            <circle class="pl-urn-ring" r={size() * 0.62} />
            <Show when={img()} fallback={<path class="pl-urn-fb" d={jar(size())} />}>
              {(src) => <image href={src()} x={-size() / 2} y={-size() / 2} width={size()} height={size()} />}
            </Show>
          </g>
        );
      }}
    </Show>
  );
}

/** A jar's outline (no pack): neck, shoulders, body. */
function jar(s: number): string {
  const h = s / 2;
  return `M${-h * 0.25} ${-h * 0.8} L${h * 0.25} ${-h * 0.8} L${h * 0.2} ${-h * 0.55} L${h * 0.6} ${-h * 0.3} L${h * 0.5} ${h * 0.75} L${-h * 0.5} ${h * 0.75} L${-h * 0.6} ${-h * 0.3} L${-h * 0.2} ${-h * 0.55} Z`;
}
