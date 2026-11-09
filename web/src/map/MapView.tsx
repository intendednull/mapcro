// The in-game minimap, rebuilt (design/shared/minimap.js, ported): frame, terrain, lane lines and
// markers from the asset pack's entities, with the board's own layers on top. Without a pack
// every image layer falls back to CSS shapes in the same tints.

import { For, type JSX, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { cx } from "../ui/cx";
import type { ObjectiveStatus } from "../gen/ObjectiveStatus";
import { type Marker, HUD_MAP_PX, isFriendly, laneStroke, offByDefault, washFor } from "./model";
import { defaultSplit, pathOf, splitAt, splitEdges } from "./lanes";
import { type Art, artCss } from "./pack";
import { FIT_VIEW, MARGIN, type Viewpoint } from "./transform";
import { buffInfo } from "../match/buffs";

/** A neutral cream: the spawners give any powerup, so no buff's own colour. */
const POWERUP = "#FFEFD7";
/** The urn's own cyan (soul_jar_marker), for the shapes drawn without a pack. */
export const URN = "#34ddff";
const CAMP_IMG = { weak: "neutral-small", medium: "neutral-medium", strong: "neutral-large", vaults: "neutral-vault" } as const;

function Layer(p: { img: string; wash?: string; style?: JSX.CSSProperties; part?: string; span?: readonly [number, number] }) {
  return p.wash ? (
    <i class={cx("w", p.part)} data-img={p.img} data-span={p.span?.join(" ")} style={{ "--wash": p.wash, ...p.style }} />
  ) : (
    <i class={cx("p", p.part)} data-pimg={p.img} data-span={p.span?.join(" ")} style={p.style} />
  );
}

/**
 * Where each fill image's shape sits in its box, top to bottom (its opaque rows): the diamonds
 * fill only the middle of theirs, so a clip over the whole box read 67% as nearly full.
 */
const SPAN = { t1: [0.281, 0.719], t2: [0.281, 0.719], shield: [0.133, 0.492], core: [0.383, 0.625], midboss: [0.172, 0.813] } as const;

/**
 * The clip that fills a layer's shape from the bottom up to `hp` percent. A layer drawn rotated
 * (a friendly Patron's shield) is clipped from its own top, which shows at the bottom.
 */
function hpClip(hp: number | undefined, span: readonly [number, number], flip = false): JSX.CSSProperties {
  if (hp === undefined) return {};
  const [top, bottom] = span;
  const lit = ((bottom - top) * hp) / 100;
  return { "clip-path": flip ? `inset(0 0 ${((1 - top - lit) * 100).toFixed(2)}% 0)` : `inset(${((bottom - lit) * 100).toFixed(2)}% 0 0 0)` };
}

function Fb(p: { shape: string; color: string; k: number; part?: string }) {
  return <b class={cx("fb", p.shape, p.part)} style={{ "--c": p.color, "--k": String(p.k) }} />;
}

/**
 * `health` (Player, replay tier): the icon fills from the bottom up to it, as in game; the
 * HUD's own fill layer (`hp-fill`) is clipped and the empty part shows its dark frame. Absent:
 * full, as in Sandbox (operator, 2026-11-08).
 */
function MarkerView(p: { m: Marker; vp: Viewpoint; status: ObjectiveStatus | undefined; picked: boolean; health?: number | undefined; camp?: string | undefined; buff?: string | undefined }) {
  const c = () => washFor(p.m, p.vp);
  // Destroyed keeps its own look.
  const hp = () => (p.health === undefined || p.status === "Destroyed" ? undefined : Math.max(0, Math.min(100, p.health)));
  const body = () => {
    const m = p.m;
    switch (m.kind) {
      case "t1":
      case "barracks":
        return [<Fb shape="diamond" color={c()} k={0.34} part="hp-fb" />, <Layer img="boss-health" wash={c()} />, <Layer img="boss-health-fill" wash={c()} part="hp-fill" span={SPAN.t1} style={hpClip(hp(), SPAN.t1)} />];
      case "t2":
        return [<Fb shape="diamond" color={c()} k={0.4} part="hp-fb" />, <Layer img="boss-health-t2" wash={c()} />, <Layer img="boss-health-fill-t2" wash={c()} part="hp-fill" span={SPAN.t2} style={hpClip(hp(), SPAN.t2)} />];
      case "shrine":
        return [<Fb shape="diamond-o" color={c()} k={0.4} />, <Layer img="boss-health-t2" wash={c()} />, <Layer img="boss-health-fill-t2" wash={c()} part="hp-fill" span={SPAN.t2} style={hpClip(hp(), SPAN.t2)} />];
      case "t3": {
        // Two stages: the shield (the arch, stage 1) over the core (the diamond, stage 2). In
        // stage 2 the shield is gone (`.stage2` hides the `st1` parts).
        const friend = isFriendly(m, p.vp);
        const rot: JSX.CSSProperties = friend ? { transform: "rotate(180deg)" } : {};
        return [
          <Fb shape={friend ? "arch-down" : "arch"} color={c()} k={0.62} part="st1" />,
          <Fb shape="diamond" color={c()} k={0.3} part="st2 hp-core-fb" />,
          <Layer img="boss-health-final" wash={c()} style={rot} part="st1" />,
          // Stage 1: the shield fills to the health; the core under it stays whole.
          <Layer img="boss-health-final-fill" wash={c()} style={{ ...rot, ...hpClip(hp(), SPAN.shield, friend) }} part="st1 hp-fill" span={SPAN.shield} />,
          <Layer img="boss-health-final-stage2" wash={c()} />,
          // Stage 2: the shield is gone and the core fills to the health.
          <Layer img="boss-health-final-stage2-fill" wash={c()} part="hp-core" span={SPAN.core} style={hpClip(p.status === "Stage2" ? hp() : undefined, SPAN.core)} />,
        ];
      }
      case "midboss":
        // No fill layer in the HUD's art: a dark copy under, the icon itself clipped over it.
        return [<Fb shape="star" color="#d9b24a" k={0.5} part="hp-fb" />, <Layer img="super-neutral-marker" part="hp-back" />, <Layer img="super-neutral-marker" part="hp-fill" span={SPAN.midboss} style={hpClip(hp(), SPAN.midboss)} />];
      case "camp":
        return [<Fb shape={m.tier === "vaults" ? "sq" : "tri"} color="#9fc6bb" k={0.35} />, <Layer img={CAMP_IMG[m.tier ?? "medium"]} />];
      case "koth":
        return [<Fb shape="dot" color="#99FFD6" k={0.5} />, <Layer img="koth" style={{ inset: "15%" }} />];
      case "powerup": {
        // Player, replay tier: the buff that's up, in its own icon and wash (match/buffs.ts).
        const b = buffInfo(p.buff);
        return b ? [<Fb shape="star" color={b.wash} k={0.8} />, <Layer img={b.img} wash={b.wash} />] : [<Fb shape="star" color={POWERUP} k={0.8} />, <Layer img="powerup" wash={POWERUP} />];
      }
      case "urn":
        // The jar; open (lit), the game's three pulses closing in on it, washed the urn's cyan
        // (hud_minimap.vxml MinimapCrateSnippet, .pingIdol1-3; styles/app.css).
        return [
          <Fb shape="dot" color={URN} k={0.375} />,
          <Layer img="urn-return" part="urn-art" />,
          ...[1, 2, 3].map((n) => <Layer img="urn-return-pulse" wash={URN} part={`urn-pulse ping${n}`} />),
        ];
    }
  };
  return (
    <div
      class={cx("mk", p.m.kind, p.m.kind === "koth" && "koth", p.m.kind === "urn" && p.status === "Active" && "lit", p.status === "Destroyed" && "down", p.status === "Hidden" && "gone", p.status === "Stage2" && "stage2", p.picked && "picked")}
      data-status={p.status ?? "Active"}
      // A named image: ARIA doesn't let a generic div carry a name.
      role="img"
      aria-label={p.m.title}
      data-key={p.m.key}
      data-health={hp() === undefined ? undefined : Math.round(hp()!)}
      data-camp={p.camp}
      data-buff={p.buff}
      style={{
        "--hp": hp() === undefined ? undefined : `${hp()}%`,
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

type Edges = { amber: number; sapphire: number };

function Lanes(p: { art: Art; vp: Viewpoint; waveT: ((lane: string) => number | undefined) | undefined; edges: ((lane: string) => Edges | undefined) | undefined; raised: string | undefined }) {
  // Each lane is drawn in two colours split where its waves meet (`Wave.t`; by default where it
  // crosses the centre line): Amber's part from its end, Sapphire's from theirs. A replay gives
  // the zipline colours' two edges instead, with the gap between left uncoloured.
  return (
    <svg class="lanes" viewBox="0 0 1000 1000" aria-hidden="true">
      <For each={p.art.model.lanes}>
        {(l) => {
          const edges = () => p.edges?.(l.key);
          const t = () => (edges() ? undefined : (p.waveT?.(l.key) ?? defaultSplit(l.line)));
          const halves = () => {
            const e = edges();
            return e ? splitEdges(l.line, e.amber, e.sapphire, LANE_GAP) : splitAt(l.line, t()!, LANE_GAP);
          };
          return (
            <g data-lane={l.lane} data-key={l.key} data-t={t()} data-amber={edges()?.amber} data-sapphire={edges()?.sapphire} class={cx(p.raised === l.key && "raised")}>
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
  /** Objectives in your group selection. */
  picked?: (key: string) => boolean;
  /** Objectives' health in percent (Player, replay tier); absent: full. */
  health?: (key: string) => number | undefined;
  /** Player, replay tier: a lane's zipline colours, which replace its split. */
  laneEdges?: (lane: string) => Edges | undefined;
  /** Player, replay tier: a camp's state ("alive", "cleared", "unspawned"), as `data-camp`. */
  camp?: (key: string) => string | undefined;
  /** Player, replay tier: the buff up at a powerup site, as `data-buff` and its icon. */
  buff?: (key: string) => string | undefined;
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
  // Zoomed in past the default view: the HUD look, a fixed frame and the view clipped to its
  // disc, wherever the view is panned, the map's edge and its notes margin included (operator,
  // 2026-11-08: the stencil vanished when a zoomed-in view panned past the map's border). At the
  // default view and out from it, the map and its frame are one picture, clipped by the box.
  const hud = () => view().w < FIT_VIEW.w - 0.5;
  const free = () => !p.lite && !hud();
  const frame = () => (
    <>
      <svg class="frame-fb" viewBox="0 0 100 100" aria-hidden="true">
        <path d="M50 7 a43 43 0 1 1 -0.01 0Z M39 9 a11 11 0 0 1 22 0 M39 91 a11 11 0 0 0 22 0" />
      </svg>
      <i class="frame-art" />
    </>
  );
  const markers = createMemo(() =>
    p.lite ? p.art.model.markers.filter((m) => m.kind !== "barracks" && m.kind !== "shrine" && m.kind !== "camp" && m.kind !== "koth" && m.kind !== "powerup" && m.kind !== "urn") : p.art.model.markers,
  );
  const hasArt = () => p.art.images.has("terrain-mid");
  return (
    <div
      ref={host}
      class={cx("mm-host", `vp-${p.viewpoint}`, p.class, p.raisedLane && "lane-raised", hasArt() && "pack-art", p.lite && "lite", hud() && "zoomed", free() && "free", p.live && "live")}
      data-viewpoint={p.viewpoint}
      data-pack={p.art.packId ?? "none"}
      style={{ "--u": `${u()}px`, "--mk-scale": String(Math.min(1, view().w / 1000)) }}
    >
      <Show when={!p.lite && !free()}>
        <div class="mm-frame">{frame()}</div>
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
          <Show when={!p.lite && free()}>
            <div class="mm-frame moving">{frame()}</div>
          </Show>
          <div class="mm-rot">
            <i class="terrain" data-pimg="terrain-mid" />
            <i class="mm-shade" />
            <Lanes art={p.art} vp={p.viewpoint} waveT={p.waveT} edges={p.laneEdges} raised={p.raisedLane} />
            <div class="mm-objs">
              <For each={markers().filter((m) => p.showHidden || p.status?.(m.key) !== "Hidden")}>
                {(m) => (
                  <MarkerView
                    m={m}
                    vp={p.viewpoint}
                    // A rift or an urn point is off unless someone turned it on; everything else is
                    // up unless destroyed.
                    status={offByDefault(m.kind) ? (p.status?.(m.key) === "Active" ? "Active" : "Destroyed") : p.status?.(m.key)}
                    picked={!!p.picked?.(m.key)}
                    health={p.health?.(m.key)}
                    camp={p.camp?.(m.key)}
                    buff={p.buff?.(m.key)}
                  />
                )}
              </For>
            </div>
          </div>
          <svg
            ref={p.overlayRef}
            viewBox="0 0 1000 1000"
            {...p.overlayProps}
            class={cx("mm-overlay", p.lite ? "mini" : "map", p.overlayClass)}
          >
            <Show when={!p.lite}>
              <rect class="notes-area" x={-MARGIN} y={-MARGIN} width={1000 + 2 * MARGIN} height={1000 + 2 * MARGIN} />
            </Show>
            {p.children}
          </svg>
        </div>
      </div>
    </div>
  );
}
