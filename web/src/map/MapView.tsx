// The in-game minimap, rebuilt (design/shared/minimap.js, ported): frame, terrain, lane lines and
// markers from the asset pack's entities, with the board's own layers on top. Without a pack
// every image layer falls back to CSS shapes in the same tints.

import { For, type JSX, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { cx } from "../ui/cx";
import type { ObjectiveStatus } from "../gen/ObjectiveStatus";
import { type Marker, HUD_MAP_PX, isFriendly, laneStroke, washFor } from "./model";
import { defaultSplit, pathOf, splitAt } from "./lanes";
import { type Art, artCss } from "./pack";
import type { Viewpoint } from "./transform";

const CAMP_IMG = { weak: "neutral-small", medium: "neutral-medium", strong: "neutral-large", vaults: "neutral-vault" } as const;

function Layer(p: { img: string; wash?: string; style?: JSX.CSSProperties }) {
  return p.wash ? (
    <i class="w" data-img={p.img} style={{ "--wash": p.wash, ...p.style }} />
  ) : (
    <i class="p" data-pimg={p.img} style={p.style} />
  );
}

function Fb(p: { shape: string; color: string; k: number }) {
  return <b class={`fb ${p.shape}`} style={{ "--c": p.color, "--k": String(p.k) }} />;
}

function MarkerView(p: { m: Marker; vp: Viewpoint; status: ObjectiveStatus | undefined }) {
  const c = () => washFor(p.m, p.vp);
  const body = () => {
    const m = p.m;
    switch (m.kind) {
      case "t1":
      case "barracks":
        return [<Fb shape="diamond" color={c()} k={0.34} />, <Layer img="boss-health" wash={c()} />, <Layer img="boss-health-fill" wash={c()} />];
      case "t2":
        return [<Fb shape="diamond" color={c()} k={0.4} />, <Layer img="boss-health-t2" wash={c()} />, <Layer img="boss-health-fill-t2" wash={c()} />];
      case "shrine":
        return [<Fb shape="diamond-o" color={c()} k={0.4} />, <Layer img="boss-health-t2" wash={c()} />, <Layer img="boss-health-fill-t2" wash={c()} />];
      case "t3": {
        const friend = isFriendly(m, p.vp);
        const rot: JSX.CSSProperties = friend ? { transform: "rotate(180deg)" } : {};
        return [
          <Fb shape={friend ? "arch-down" : "arch"} color={c()} k={0.62} />,
          <Layer img="boss-health-final" wash={c()} style={rot} />,
          <Layer img="boss-health-final-fill" wash={c()} style={rot} />,
          <Layer img="boss-health-final-stage2" wash={c()} />,
          <Layer img="boss-health-final-stage2-fill" wash={c()} />,
        ];
      }
      case "midboss":
        return [<Fb shape="star" color="#d9b24a" k={0.5} />, <Layer img="super-neutral-marker" />];
      case "camp":
        return [<Fb shape={m.tier === "vaults" ? "sq" : "tri"} color="#9fc6bb" k={0.35} />, <Layer img={CAMP_IMG[m.tier ?? "medium"]} />];
      case "koth":
        return [<Fb shape="dot" color="#99FFD6" k={0.5} />, <Layer img="koth" style={{ inset: "15%" }} />];
    }
  };
  return (
    <div
      class={cx("mk", p.m.kind, p.m.kind === "koth" && "koth", p.status === "Destroyed" && "down", p.status === "Hidden" && "gone")}
      data-status={p.status ?? "Active"}
      title={p.m.title}
      data-key={p.m.key}
      style={{
        left: `${p.m.at.x / 10}%`,
        top: `${p.m.at.y / 10}%`,
        width: `${(p.m.px / HUD_MAP_PX) * 100}%`,
        height: `${(p.m.px / HUD_MAP_PX) * 100}%`,
        "z-index": p.m.z,
      }}
    >
      {body()}
    </div>
  );
}

/** Gap at the split, in map units of arc length: the contested zone between the waves. */
export const LANE_GAP = 12;

function Lanes(p: { art: Art; vp: Viewpoint; waveT: ((lane: string) => number | undefined) | undefined; raised: string | undefined }) {
  // Each lane is drawn in two colours split where its waves meet (`Wave.t`; by default where it
  // crosses the centre line): Amber's part from its end, Sapphire's from theirs.
  return (
    <svg class="lanes" viewBox="0 0 1000 1000" aria-hidden="true">
      <For each={p.art.model.lanes}>
        {(l) => {
          const t = () => p.waveT?.(l.key) ?? defaultSplit(l.line);
          const halves = () => splitAt(l.line, t(), LANE_GAP);
          return (
            <g data-lane={l.lane} data-key={l.key} data-t={t()} class={cx(p.raised === l.key && "raised")}>
              <path d={pathOf(halves().amber)} stroke={laneStroke(l.lane, "amber", p.vp)} data-half="amber" />
              <path d={pathOf(halves().sapphire)} stroke={laneStroke(l.lane, "sapphire", p.vp)} data-half="sapphire" />
            </g>
          );
        }}
      </For>
    </svg>
  );
}

let styleEl: HTMLStyleElement | undefined;
function useArtCss(art: () => Art) {
  createEffect(() => {
    const css = artCss(art());
    styleEl ??= document.head.appendChild(document.createElement("style"));
    styleEl.dataset.mapcroArt = art().packId ?? "none";
    styleEl.textContent = css;
  });
}

export interface ViewRect {
  x: number;
  y: number;
  w: number;
}

export function MapView(p: {
  art: Art;
  viewpoint: Viewpoint;
  /** Visible part of the map, in view units (default: all of it). */
  view?: ViewRect;
  lite?: boolean;
  live?: boolean;
  class?: string;
  /** Board layers, drawn in view units (0..1000) above the map. */
  children?: JSX.Element;
  overlayRef?: (el: SVGSVGElement) => void;
  overlayProps?: JSX.SvgSVGAttributes<SVGSVGElement>;
  overlayClass?: string | false | undefined;
  /** Objective state in the scene shown (absent = active). */
  status?: (key: string) => ObjectiveStatus | undefined;
  /** Editors still see hidden objectives, as ghosts, so they can bring them back. */
  showHidden?: boolean;
  /** Lane equilibrium: the split `t` for a lane key, if the scene has one. */
  waveT?: (lane: string) => number | undefined;
  /** The lane being dragged: the map hides it while the board draws it above everything. */
  raisedLane?: string | undefined;
}) {
  useArtCss(() => p.art);
  let host!: HTMLDivElement;
  const [u, setU] = createSignal(1);
  onMount(() => {
    const ro = new ResizeObserver(() => {
      const clip = host.querySelector<HTMLElement>(".mm-clip");
      setU((clip?.clientWidth || host.clientWidth) / HUD_MAP_PX);
    });
    ro.observe(host);
    onCleanup(() => ro.disconnect());
  });
  const view = () => p.view ?? { x: 0, y: 0, w: 1000 };
  const markers = createMemo(() =>
    p.lite ? p.art.model.markers.filter((m) => m.kind !== "barracks" && m.kind !== "shrine" && m.kind !== "camp" && m.kind !== "koth") : p.art.model.markers,
  );
  const hasArt = () => p.art.images.has("terrain-mid");
  return (
    <div
      ref={host}
      class={cx("mm-host", `vp-${p.viewpoint}`, p.class, p.raisedLane && "lane-raised", hasArt() && "pack-art", p.lite && "lite", view().w < 1000 && "zoomed", p.live && "live")}
      data-viewpoint={p.viewpoint}
      data-pack={p.art.packId ?? "none"}
      style={{ "--u": `${u()}px`, "--mk-scale": String(view().w / 1000) }}
    >
      <Show when={!p.lite}>
        <div class="mm-frame">
          <svg class="frame-fb" viewBox="0 0 100 100" aria-hidden="true">
            <path d="M50 7 a43 43 0 1 1 -0.01 0Z M39 9 a11 11 0 0 1 22 0 M39 91 a11 11 0 0 0 22 0" />
          </svg>
          <i class="frame-art" />
        </div>
      </Show>
      <div class="mm-clip">
        <div
          class="mm-zoom"
          style={{
            width: `${(1000 / view().w) * 100}%`,
            height: `${(1000 / view().w) * 100}%`,
            left: `${(-view().x / view().w) * 100}%`,
            top: `${(-view().y / view().w) * 100}%`,
          }}
        >
          <div class="mm-rot">
            <i class="terrain" data-pimg="terrain-mid" />
            <i class="mm-shade" />
            <Lanes art={p.art} vp={p.viewpoint} waveT={p.waveT} raised={p.raisedLane} />
            <div class="mm-objs">
              <For each={markers().filter((m) => p.showHidden || p.status?.(m.key) !== "Hidden")}>
                {(m) => (
                  <MarkerView
                    m={m}
                    vp={p.viewpoint}
                    // A rift is off unless someone turned it on; everything else is up unless destroyed.
                    status={m.kind === "koth" ? (p.status?.(m.key) === "Active" ? "Active" : "Destroyed") : p.status?.(m.key)}
                  />
                )}
              </For>
            </div>
          </div>
          <svg ref={p.overlayRef} viewBox="0 0 1000 1000" {...p.overlayProps} class={cx("mm-overlay", p.lite ? "mini" : "map", p.overlayClass)}>
            {p.children}
          </svg>
        </div>
      </div>
    </div>
  );
}
