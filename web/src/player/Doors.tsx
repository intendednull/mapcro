// Doorman doorway indicators on the minimap (Player + Scenes; docs/specs/doorman-doors-design.md §1).
//
// Renders Valve's extracted `icons/doorman_doorway_psd` (or pixel-matched inline SVG fallback
// `DOOR_FB`) upright inside a compact `#0b1714` circular badge with a team-colored rim (`--amber`
// / `--sapphire`), curved dashed Bézier link arcs between linked pairs, pair-wide hover highlights
// (local or followed presenter), `visionFade` in Player, and D3 faded + eye-slash state in Scenes.

import { For, Show, createMemo, createSignal } from "solid-js";
import { visionFade } from "../board/fade";
import type { TokenFrame } from "../board/Tokens";
import type { WorldPos } from "../gen/WorldPos";
import { localHover, remoteHover } from "../map/HoverLabel";
import { teamName } from "../map/model";
import type { Art } from "../map/pack";
import { type Pt, type Viewpoint, worldToView } from "../map/transform";
import { type DoorIdentity, resolveDoorIndex } from "../mapstate/edit";
import { type ShownDoor, shownDoors } from "../mapstate/shown";
import { cx } from "../ui/cx";

/** Deadlock hero_id for The Doorman (`data/heroes.json`). */
export const DOORMAN_HERO_ID = 69;
/** Minimum view-unit distance between Door 1 and Door 2 to commit a linked pair vs unpaired Door 1. */
export const DOOR_PAIR_MIN_DIST = 12;

export interface PlacingDoor {
  team: "amber" | "sapphire";
  /** Anchored Door 1 world position in Step 2; absent in Step 1 (armed from portrait). */
  door1?: WorldPos;
  /** Existing unpaired door index when linking a second door via `door-menu-link`. */
  linkIndex?: number;
  /** Identity of the unpaired door captured at gesture start (`door-menu-link`). */
  linkExpect?: DoorIdentity;
  /** Current pointer position in overlay view units for live link & ghost Door 2 preview. */
  pointer?: Pt;
  /** True when driven by touch (suppresses floating ghost Door 2 badge per design §2.3). */
  touch?: boolean;
}

export interface DragDoor {
  index: number;
  expect: DoorIdentity;
  pos: WorldPos;
}

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
  erasingDoors?: (() => ReadonlySet<number>) | undefined;
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
        const erasing = () => {
          const set = p.erasingDoors?.();
          return !!set && (set.has(pair().a.id) || set.has(pair().b.id));
        };
        return (
          <g ref={setLinkEl} class="pl-door-link-wrap" data-fading={vf.leaving() ? "out" : undefined} aria-hidden="true">
            <Show when={d()}>
              {(path) => (
                <g
                  class={cx("pl-door-link", pair().a.team, hot() && "hot", faded() && "faded", erasing() && "erasing")}
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
          </g>
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
  editable: () => boolean;
  hitR: () => number;
  dragging: () => boolean;
  erasingDoors?: (() => ReadonlySet<number>) | undefined;
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
        const erasing = () => {
          const set = p.erasingDoors?.();
          return !!set && (set.has(d().id) || (d().partner !== null && set.has(d().partner!)));
        };
        const r = () => DOOR_R * p.k;
        const glyph = () => DOOR_GLYPH * p.k * (hot() ? 1.08 : 1);
        const dashed = () => (!linked() && !hot()) || faded();
        const rimWidth = () => (hot() ? 2.6 : linked() ? 2.4 : 2) * p.k;
        return (
          <g
            ref={setEl}
            class={cx(
              "pl-door",
              d().team,
              linked() ? "linked" : "unpaired",
              hot() && "hot",
              faded() && "faded",
              p.editable() && "editable",
              p.dragging() && "dragging",
              erasing() && "erasing",
            )}
            data-testid="doorman-door"
            data-door-id={d().id}
            data-erase-door={!p.frame.player() ? String(d().id) : undefined}
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
            <Show when={p.editable()}>
              <circle class="pl-hit" r={p.hitR()} />
            </Show>
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

function PreviewDoorGlyph(p: { art: Art; k: number; team: "amber" | "sapphire"; linked: boolean; ghost?: boolean; at: Pt; testid: string }) {
  const img = () => p.art.images.get("doorman-door");
  const r = () => DOOR_R * p.k;
  const glyph = () => DOOR_GLYPH * p.k;
  return (
    <g
      class={cx("pl-door", p.team, p.linked ? "linked" : "unpaired", p.ghost ? "ghost" : "preview")}
      data-testid={p.testid}
      data-team={p.team}
      transform={`translate(${p.at.x} ${p.at.y})`}
      aria-hidden="true"
    >
      <g class="pl-door-badge">
        <circle class="pl-door-bg" r={r()} />
        <circle
          class="pl-door-rim"
          r={r()}
          stroke-width={(p.linked ? 2.4 : 2) * p.k}
          stroke-dasharray={!p.linked ? `${3.5 * p.k} ${2.5 * p.k}` : undefined}
        />
        <image class="pl-door-art" href={img() ?? DOOR_FB} x={-glyph() / 2} y={-glyph() / 2} width={glyph()} height={glyph()} />
      </g>
    </g>
  );
}

export function DoormanDoors(p: {
  art: Art;
  vp: Viewpoint;
  frame: TokenFrame;
  k: number;
  editable?: () => boolean;
  phone?: boolean;
  unitsPerPx?: () => number;
  dragDoor?: () => DragDoor | undefined;
  erasingDoors?: () => ReadonlySet<number>;
  placingDoor?: () => PlacingDoor | undefined;
}) {
  const resolvedDragIndex = createMemo(() => {
    const drag = p.dragDoor?.();
    if (!drag) return undefined;
    return resolveDoorIndex(p.frame.ms().scene().doors(), drag.index, drag.expect);
  });
  const doors = createMemo(() => {
    const drag = p.dragDoor?.();
    const dragIdx = resolvedDragIndex();
    const list = shownDoors(p.frame.ms(), p.frame.shown().vision, !p.frame.player());
    if (!drag || dragIdx === undefined) return list;
    return list.map((d) => (d.id === dragIdx ? { ...d, at: drag.pos } : d));
  });
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

  const editable = () => !!p.editable?.();
  const hitR = () => {
    const upp = p.unitsPerPx?.() ?? 0;
    const coarse = p.phone || (typeof window !== "undefined" && !!window.matchMedia?.("(pointer: coarse)").matches);
    return Math.max(DOOR_R * p.k, (coarse ? 22 : 6) * upp);
  };

  return (
    <g class="pl-doors" data-testid="doorman-doors">
      <For each={pairKeys()}>
        {(key) => (
          <DoorLink
            pairKey={key}
            pair={() => pairsMap().get(key)}
            vp={p.vp}
            k={p.k}
            frame={p.frame}
            hovered={hoveredDoorId}
            erasingDoors={p.erasingDoors}
          />
        )}
      </For>
      <For each={doorIds()}>
        {(id) => (
          <DoorBadge
            id={id}
            door={() => byId().get(id)}
            art={p.art}
            vp={p.vp}
            k={p.k}
            frame={p.frame}
            hovered={hoveredDoorId}
            editable={editable}
            hitR={hitR}
            dragging={() => resolvedDragIndex() === id}
            erasingDoors={p.erasingDoors}
          />
        )}
      </For>
      <Show when={p.placingDoor?.()}>
        {(pl) => {
          const p1 = () => (pl().door1 ? worldToView(pl().door1!, p.vp) : undefined);
          const ptr = () => pl().pointer;
          const pairDist = () => {
            const a = p1();
            const b = ptr();
            return a && b ? Math.hypot(b.x - a.x, b.y - a.y) : 0;
          };
          const minDist = () => (pl().touch ? Math.max(DOOR_PAIR_MIN_DIST, DOOR_R * p.k * 1.5) : DOOR_PAIR_MIN_DIST);
          const showPair = () => !!p1() && !!ptr() && pairDist() >= minDist();
          const linkD = () => (showPair() ? doorLinkPath(p1()!, ptr()!, p.k) : null);
          return (
            <>
              <Show when={linkD()}>
                {(path) => (
                  <g class={cx("pl-door-link", "preview", pl().team)} data-testid="door-preview-link" data-team={pl().team} aria-hidden="true">
                    <path class="pl-door-link-casing" d={path()} />
                    <path class="pl-door-link-thread" d={path()} />
                  </g>
                )}
              </Show>
              <Show when={p1() && pl().linkIndex === undefined}>
                <PreviewDoorGlyph art={p.art} k={p.k} team={pl().team} linked={showPair()} at={p1()!} testid="door-preview-1" />
              </Show>
              <Show when={!p1() && ptr() && !pl().touch}>
                <PreviewDoorGlyph art={p.art} k={p.k} team={pl().team} linked={false} ghost at={ptr()!} testid="door-preview-1" />
              </Show>
              <Show when={showPair() && !pl().touch && ptr()}>
                <PreviewDoorGlyph art={p.art} k={p.k} team={pl().team} linked ghost at={ptr()!} testid="door-preview-2" />
              </Show>
            </>
          );
        }}
      </Show>
    </g>
  );
}
