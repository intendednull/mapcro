// Doorman doorway indicators on the minimap (Player + Scenes; docs/specs/doorman-doors-design.md §1).
//
// Renders Valve's extracted `icons/doorman_doorway_psd` (or pixel-matched inline SVG fallback
// `DOOR_FB`) upright inside a compact `#0b1714` circular badge with a team-colored rim (`--amber`
// / `--sapphire`), curved dashed Bézier link arcs between linked pairs, pair-wide hover highlights
// (local or followed presenter), `visionFade` in Player, and D3 faded + eye-slash state in Scenes.

import { For, Show, createMemo, createSignal } from "solid-js";
import { visionFade } from "../board/fade";
import type { TokenFrame } from "../board/Tokens";
import { localHover, remoteHover } from "../map/HoverLabel";
import { teamName } from "../map/model";
import type { Art } from "../map/pack";
import { type Pt, type Viewpoint, worldToView } from "../map/transform";
import { type ShownDoor, shownDoors } from "../mapstate/shown";
import { cx } from "../ui/cx";

/** Backing badge radius in overlay view units (diameter 28 * k = 61% of a hero token). */
export const DOOR_R = 14;
/** Little-door icon box size in overlay view units inside the badge. */
export const DOOR_GLYPH = 21;
/** Hover marker prefix (`marker:door:<id>`). */
export const DOOR_HOVER_PREFIX = "door:";

/** Pixel-matched inline SVG fallback for `icons/doorman_doorway_psd` (137 × 137, evenodd). */
export const DOOR_FB =
  "data:image/svg+xml," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 137 137"><path fill="#FFEFD7" fill-rule="evenodd" d="M19 59L32 70.5L19 82ZM36 23H55V29H42V111H55V117H36ZM61 7L103 24V116L61 132ZM69 64.5A5.5 5.5 0 1 0 69 75.5A5.5 5.5 0 1 0 69 64.5Z"/></svg>',
  );

const EYE = "M-6 0s2.4-4 6-4 6 4 6 4-2.4 4-6 4-6-4-6-4z";

/**
 * Quadratic Bézier link arc between two linked door badges in overlay view units:
 * - Trims endpoints to the outer edge of each `DOOR_R * k` badge.
 * - Suppresses short spans (`d <= 2.4 * DOOR_R * k`) where badges sit adjacent.
 * - Bows gently toward map centre `(500, 500)` by `min(26 * k, 0.12 * d)`.
 */
export function doorLinkPath(a: Pt, b: Pt, k: number): string | null {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const d = Math.hypot(dx, dy);
  if (d <= 2.4 * DOOR_R * k) return null;
  const ux = dx / d;
  const uy = dy / d;
  const r = DOOR_R * k;
  const a1x = a.x + ux * r;
  const a1y = a.y + uy * r;
  const b1x = b.x - ux * r;
  const b1y = b.y - uy * r;
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2;
  const nx = -uy;
  const ny = ux;
  const sign = (500 - mx) * nx + (500 - my) * ny >= 0 ? 1 : -1;
  const bow = Math.min(26 * k, 0.12 * d);
  const cxPt = mx + nx * sign * bow;
  const cyPt = my + ny * sign * bow;
  return `M${a1x.toFixed(1)} ${a1y.toFixed(1)} Q${cxPt.toFixed(1)} ${cyPt.toFixed(1)} ${b1x.toFixed(1)} ${b1y.toFixed(1)}`;
}

const sameArr = <T,>(a: readonly T[], b: readonly T[]) => a.length === b.length && a.every((v, i) => v === b[i]);

function DoorLink(p: {
  pairKey: string;
  pair: () => { a: ShownDoor; b: ShownDoor } | undefined;
  vp: Viewpoint;
  k: number;
  frame: TokenFrame;
  hovered: () => number | undefined;
}) {
  const drawn = () => {
    const x = p.pair();
    return x && x.a.draw !== "hidden" && x.b.draw !== "hidden" ? x : undefined;
  };
  const hidden = () => {
    const x = p.pair();
    return x != null && (x.a.draw === "hidden" || x.b.draw === "hidden");
  };
  const [linkEl, setLinkEl] = createSignal<SVGGElement>();
  const vf = visionFade({ value: drawn, hidden, smooth: p.frame.smooth, el: linkEl });
  return (
    <Show when={vf.shown()}>
      {(pair) => {
        const d = () => doorLinkPath(worldToView(pair().a.at, p.vp), worldToView(pair().b.at, p.vp), p.k);
        const hot = () => {
          const h = p.hovered();
          return h !== undefined && (h === pair().a.id || h === pair().b.id);
        };
        const faded = () => pair().a.draw === "faded" || pair().b.draw === "faded";
        return (
          <Show when={d()}>
            {(path) => (
              <g
                ref={setLinkEl}
                class={cx("pl-door-link", pair().a.team, hot() && "hot", faded() && "faded")}
                data-testid="door-link"
                data-pair={p.pairKey}
                data-team={pair().a.team}
                data-hot={hot() ? "" : undefined}
                data-faded={faded() ? "" : undefined}
                data-fading={vf.leaving() ? "out" : undefined}
                aria-hidden="true"
              >
                <path class="pl-door-link-casing" d={path()} />
                <path class="pl-door-link-thread" d={path()} />
              </g>
            )}
          </Show>
        );
      }}
    </Show>
  );
}

function DoorBadge(p: {
  id: number;
  door: () => ShownDoor | undefined;
  art: Art;
  vp: Viewpoint;
  k: number;
  frame: TokenFrame;
  hovered: () => number | undefined;
}) {
  const drawn = () => {
    const d = p.door();
    return d && d.draw !== "hidden" ? d : undefined;
  };
  const [el, setEl] = createSignal<SVGGElement>();
  const vf = visionFade({ value: drawn, hidden: () => p.door()?.draw === "hidden", smooth: p.frame.smooth, el });
  const img = () => p.art.images.get("doorman-door");
  return (
    <Show when={vf.shown()}>
      {(d) => {
        const at = () => worldToView(d().at, p.vp);
        const linked = () => d().role !== "unpaired" && d().partner !== null;
        const faded = () => d().draw === "faded";
        const hot = () => {
          const h = p.hovered();
          return h !== undefined && (h === d().id || h === d().partner);
        };
        const r = () => DOOR_R * p.k;
        const glyph = () => DOOR_GLYPH * p.k * (hot() ? 1.08 : 1);
        const dashed = () => (!linked() && !hot()) || faded();
        const rimWidth = () => (hot() ? 2.6 : linked() ? 2.4 : 2) * p.k;
        return (
          <g
            ref={setEl}
            class={cx("pl-door", d().team, linked() ? "linked" : "unpaired", hot() && "hot", faded() && "faded")}
            data-testid="doorman-door"
            data-door-id={d().id}
            data-team={d().team}
            data-role={d().role}
            data-partner={d().partner != null ? String(d().partner) : undefined}
            data-hot={hot() ? "" : undefined}
            data-faded={faded() ? "" : undefined}
            data-fading={vf.leaving() ? "out" : undefined}
            data-art={img() ? "pack" : "fallback"}
            data-x={Math.round(d().at.x)}
            data-y={Math.round(d().at.y)}
            aria-label={`${teamName(d().team)} Doorway`}
            transform={`translate(${at().x} ${at().y})`}
          >
            <g class="pl-door-badge">
              <Show when={hot()}>
                <circle class="pl-door-hot-ring" r={(DOOR_R + 3.5) * p.k} stroke-width={1.6 * p.k} />
              </Show>
              <circle class="pl-door-bg" r={r()} />
              <circle
                class="pl-door-rim"
                r={r()}
                stroke-width={rimWidth()}
                stroke-dasharray={dashed() ? `${3.5 * p.k} ${2.5 * p.k}` : undefined}
              />
              <image
                class="pl-door-art"
                href={img() ?? DOOR_FB}
                x={-glyph() / 2}
                y={-glyph() / 2}
                width={glyph()}
                height={glyph()}
              />
            </g>
            <Show when={faded()}>
              <g class="vis off" data-testid="door-unseen-mark" transform={`translate(${DOOR_R * 0.75 * p.k} ${-DOOR_R * 0.75 * p.k}) scale(${0.75 * p.k})`}>
                <circle r="9" />
                <path d={EYE} />
                <path class="slash" d="M-6 6L6 -6" />
              </g>
            </Show>
          </g>
        );
      }}
    </Show>
  );
}

export function DoormanDoors(p: { art: Art; vp: Viewpoint; frame: TokenFrame; k: number }) {
  const doors = createMemo(() => shownDoors(p.frame.ms(), p.frame.shown().vision, !p.frame.player()));
  const byId = createMemo(() => new Map(doors().map((d) => [d.id, d])));
  const doorIds = createMemo(() => doors().map((d) => d.id), undefined, { equals: sameArr });

  const pairsMap = createMemo(() => {
    const m = byId();
    const out = new Map<string, { a: ShownDoor; b: ShownDoor }>();
    for (const d of doors()) {
      if (d.role === "unpaired" || d.partner === null || d.id >= d.partner) continue;
      const partner = m.get(d.partner);
      if (partner && partner.partner === d.id && partner.team === d.team) {
        out.set(`${d.id}:${partner.id}`, { a: d, b: partner });
      }
    }
    return out;
  });
  const pairKeys = createMemo(() => [...pairsMap().keys()], undefined, { equals: sameArr });

  // Highlight both doors and their link arc when either door is hovered locally or by a followed presenter.
  const hoveredDoorId = createMemo(() => {
    const l = localHover();
    const ref = l ? l : remoteHover()?.ref;
    if (ref?.kind !== "marker" || !ref.id.startsWith(DOOR_HOVER_PREFIX)) return undefined;
    const n = Number(ref.id.slice(DOOR_HOVER_PREFIX.length));
    return Number.isInteger(n) ? n : undefined;
  });

  return (
    <g class="pl-doors" data-testid="doorman-doors">
      <For each={pairKeys()}>
        {(key) => <DoorLink pairKey={key} pair={() => pairsMap().get(key)} vp={p.vp} k={p.k} frame={p.frame} hovered={hoveredDoorId} />}
      </For>
      <For each={doorIds()}>
        {(id) => <DoorBadge id={id} door={() => byId().get(id)} art={p.art} vp={p.vp} k={p.k} frame={p.frame} hovered={hoveredDoorId} />}
      </For>
    </g>
  );
}
