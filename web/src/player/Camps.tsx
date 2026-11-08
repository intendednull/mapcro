// Jungle camps and the mid boss in Player (replay tier, spec §6b). The map shows only each
// camp's state, through the board's own marker looks (alive, cleared dimmed, not yet spawned
// fainter). Hovering one, or tapping it on the phone, says when it comes back; no countdown
// shows otherwise.

import { Show, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import type { Art } from "../map/pack";
import { HUD_MAP_PX } from "../map/model";
import { type Pt, mapToView } from "../map/transform";
import { svgPoint } from "../board/Tokens";
import { type CampAt, clockLabel } from "../match/timeline";
import type { MatchPreview } from "../match/preview";

/** The tooltip for a camp at playback time t. */
export function campTip(c: CampAt, t: number): string {
  if (c.state === "unspawned") return `Spawns at ${clockLabel(c.at)}`;
  if (c.state === "cleared") return `Respawns in ${clockLabel(Math.max(0, Math.ceil(c.at - t)))} (at ${clockLabel(c.at)})`;
  return "Up";
}

export function CampTips(p: { art: Art; vp: "amber" | "sapphire" | "neutral"; preview: () => MatchPreview | undefined; t: () => number; k: number }) {
  let g!: SVGGElement;
  const [hover, setHover] = createSignal<string>();
  const camps = createMemo(() => {
    const pv = p.preview();
    if (!pv || pv.camps.size === 0) return [];
    return p.art.model.markers.filter((m) => (m.kind === "camp" || m.kind === "midboss") && pv.camps.has(m.key));
  });
  const near = (at: Pt) => {
    let best: { key: string; d: number } | undefined;
    for (const m of camps()) {
      const v = mapToView(m.at, p.vp);
      const d = Math.hypot(v.x - at.x, v.y - at.y);
      // About the icon's drawn size: markers draw at ~40% of their HUD box.
      const r = Math.max(8, (m.px / HUD_MAP_PX) * 1000 * 0.25 * p.k);
      if (d <= r && (!best || d < best.d)) best = { key: m.key, d };
    }
    return best?.key;
  };
  onMount(() => {
    // Listened to on the overlay itself, never intercepting: drawing, the laser and the tools
    // work over a camp as anywhere else.
    const svg = g.ownerSVGElement;
    if (!svg) return;
    const move = (e: PointerEvent) => {
      if (e.pointerType === "mouse" || e.pointerType === "pen") setHover(near(svgPoint(svg, e)));
    };
    const leave = (e: PointerEvent) => {
      if (e.pointerType === "mouse" || e.pointerType === "pen") setHover(undefined);
    };
    const down = (e: PointerEvent) => {
      if (e.pointerType !== "touch") return;
      const k = near(svgPoint(svg, e));
      setHover((h) => (k && k !== h ? k : undefined));
    };
    svg.addEventListener("pointermove", move, { passive: true });
    svg.addEventListener("pointerleave", leave, { passive: true });
    svg.addEventListener("pointerdown", down, { passive: true });
    onCleanup(() => {
      svg.removeEventListener("pointermove", move);
      svg.removeEventListener("pointerleave", leave);
      svg.removeEventListener("pointerdown", down);
    });
  });
  const tip = createMemo(() => {
    const key = hover();
    const m = key ? camps().find((x) => x.key === key) : undefined;
    const c = key ? p.preview()?.camps.get(key) : undefined;
    if (!m || !c) return undefined;
    const at = mapToView(m.at, p.vp);
    const above = Math.max(10, (m.px / HUD_MAP_PX) * 1000 * 0.22 * p.k) + 6 * p.k;
    return { key: m.key, x: at.x, y: at.y - above, text: campTip(c, p.t()) };
  });
  return (
    <g ref={g} class="camp-tips">
      <Show when={tip()}>
        {(x) => {
          const size = () => 24 * p.k;
          // A pill behind the text, sized by its length (no layout read).
          const w = () => x().text.length * size() * 0.56 + size();
          return (
            <g class="camp-tip" data-testid="camp-tip" data-key={x().key}>
              <rect x={x().x - w() / 2} y={x().y - size() * 1.05} width={w()} height={size() * 1.45} rx={size() * 0.4} />
              <text x={x().x} y={x().y} font-size={String(size())}>
                {x().text}
              </text>
            </g>
          );
        }}
      </Show>
    </g>
  );
}
