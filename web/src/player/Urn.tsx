// The Soul Urn in Player (replay tier, spec §6b): the urn where it is, on the ground or on its
// carrier, drawn as the game's minimap draws it, from the match at playback time t. The delivery
// point is a map marker (MapView, kind "urn"), lit while open; hovering a point says when the
// next urn spawns (player/Camps.tsx).

import { Show } from "solid-js";
import { cx } from "../ui/cx";
import type { Art } from "../map/pack";
import { worldToView } from "../map/transform";
import { HUD_PX } from "../map/model";
import { TOKEN_R } from "../board/Tokens";
import { type UrnNow, clockLabel } from "../match/timeline";
import type { MatchPreview } from "../match/preview";

/**
 * Sizes and offsets from the game's minimap, panorama/styles/hud_minimap.vcss (pack
 * hud/hud_minimap.vcss), in HUD px on the 360 px map:
 * - On the ground, `.map_button.idol_spawn`: 32 × 32, `soul_jar_marker` at 100%, the same box
 *   as a rift (`.capture_point`, 32 × 32); `img-shadow: 0 0 18px shardColor&50` (styles/app.css).
 *   A dropped urn is the same marker: the game has no dropped look (`.idol_dropping` is unused
 *   debug styling, a magenta border).
 * - Carried, `.held_idol_image` on the carrier's minimap icon: 32 × 32, `translateX(8px)
 *   translateY(10px)` from the icon's corner, a white `img-shadow` and a 1.3 s pulse. The hero
 *   icon's own size is set by the game's code, not its CSS: we take it as the held image's
 *   32 px, so the urn is a hero token's size, offset by 8/32 and 10/32 of it. No team colour:
 *   the carrier's own icon says whose it is.
 */
const GROUND_HUD_PX = 32;
const HELD_OFFSET = { x: 8 / 32, y: 10 / 32 } as const;

/** What urn point `key` says at playback time t: open for delivery, or the urn spawning there
 * next; nothing otherwise (Camps.tsx's rules). */
export function urnTip(u: UrnNow, key: string, t: number): string | undefined {
  if (u.delivery === key) return "Urn delivery point";
  const n = u.next;
  if (u.state !== "none" || !n) return undefined;
  const when = `in ${clockLabel(Math.max(0, Math.ceil(n.t - t)))}`;
  return n.key === key ? `Urn spawns ${when}` : `Urn spawns at the other site ${when}`;
}

/** `mk`: the map markers' scale (a rift's), for the urn on the ground; `k`: the hero tokens'. */
export function UrnMark(p: { art: Art; vp: "amber" | "sapphire" | "neutral"; preview: () => MatchPreview | undefined; k: number; mk: number }) {
  const u = () => {
    const x = p.preview()?.urn;
    return x && x.state !== "none" && x.at ? x : undefined;
  };
  const img = () => p.art.images.get("urn");
  return (
    <Show when={u()}>
      {(x) => {
        const carried = () => x().state === "carried";
        const size = () => (carried() ? 2 * TOKEN_R * p.k : GROUND_HUD_PX * HUD_PX * p.mk);
        const at = () => {
          const v = worldToView(x().at!, p.vp);
          if (!carried()) return v;
          const d = 2 * TOKEN_R * p.k;
          return { x: v.x + d * HELD_OFFSET.x, y: v.y + d * HELD_OFFSET.y };
        };
        return (
          <g
            class={cx("pl-urn", `urn-${x().state}`)}
            data-testid="urn"
            data-state={x().state}
            data-team={x().team ?? ""}
            data-x={Math.round(x().at!.x)}
            data-y={Math.round(x().at!.y)}
            transform={`translate(${at().x} ${at().y})`}
          >
            <image class="pl-urn-art" href={img() ?? JAR_FB} x={-size() / 2} y={-size() / 2} width={size()} height={size()} />
          </g>
        );
      }}
    </Show>
  );
}

/** Without the pack: a jar in the urn's cyan, where soul_jar_marker's opaque part sits in its
 * 128 px box (60 × 100 at 34, 14). */
const JAR_FB =
  "data:image/svg+xml," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><path d="M56 14H72L74 30L94 42L88 114H40L34 42L54 30Z" fill="#34ddff" stroke="#0b1714" stroke-width="3"/></svg>',
  );
