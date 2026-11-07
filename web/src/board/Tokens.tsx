// Hero tokens on the map: one per roster slot in the current scene. With the Move tool an
// editor drags a token; while dragging, its position travels through presence (others watch it
// move, with the dragger's name tag), and the drop commits one op (spec §4a).

import { For, Show, createMemo, createSignal } from "solid-js";
import { colorOf } from "../core/device";
import type { PeerPresence } from "../gen/PeerPresence";
import type { RecordId } from "../gen/RecordId";
import type { WorldPos } from "../gen/WorldPos";
import type { Art } from "../map/pack";
import { type Pt, type Viewpoint, clampToMap, viewToWorld, worldToView } from "../map/transform";
import type { BoardState, Player, Slot } from "./state";

export const TOKEN_R = 23;

/** Pointer → view units (0..1000) of the overlay SVG, whatever its size, pan or zoom. */
export function svgPoint(svg: SVGSVGElement, e: { clientX: number; clientY: number }): Pt {
  const m = svg.getScreenCTM();
  if (!m) return { x: 0, y: 0 };
  const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(m.inverse());
  return { x: p.x, y: p.y };
}

export function initials(slot: Slot["slot"], heroName: string | undefined): string {
  const src = slot.name.trim() || heroName || "";
  const words = src.split(/\s+/).filter(Boolean);
  if (words.length >= 2) return (words[0]![0]! + words[1]![0]!).toUpperCase();
  if (src) return src.slice(0, 2).toUpperCase();
  return `${slot.team === "Amber" ? "A" : "S"}${slot.slot + 1}`;
}

export function NameTag(p: { at: Pt; name: string; color: number; what?: string | undefined; k: number }) {
  const label = () => (p.what ? `${p.name || "Someone"} · ${p.what}` : p.name || "Someone");
  const w = () => 20 + label().length * 9.4;
  return (
    <g class="p-tag" transform={`translate(${p.at.x + 30 * p.k} ${p.at.y - 46 * p.k}) scale(${p.k})`} data-tag={p.name}>
      <rect width={w()} height="28" rx="5" fill={colorOf(p.color)} />
      <text x="10" y="14">
        {label()}
      </text>
    </g>
  );
}

interface Drag {
  player: RecordId;
  pointer: number;
  pos: WorldPos;
  moved: boolean;
}

export function Tokens(p: {
  state: BoardState;
  art: Art;
  vp: Viewpoint;
  scene: RecordId | undefined;
  tool: string;
  /** Marker scale for zoom: tokens keep their on-screen size. */
  k: number;
  svg: () => SVGSVGElement | undefined;
}) {
  const [drag, setDrag] = createSignal<Drag | undefined>();
  const slots = createMemo(() => new Map(p.state.roster().map((s) => [s.id, s.slot])));
  const players = createMemo(() => p.state.playersIn(p.scene).filter((pl) => slots().has(pl.state.slot)));

  /** Others' drags and focus, by the record they touch. Viewers' drags never arrive. */
  const touching = createMemo(() => {
    const m = new Map<RecordId, PeerPresence[]>();
    for (const peer of p.state.peerList()) {
      const s = peer.state!;
      const id = s.drag?.id ?? s.focus;
      if (id) m.set(id, [...(m.get(id) ?? []), peer]);
    }
    return m;
  });

  const editable = () => p.tool === "move" && p.state.canEdit();

  const down = (pl: Player, e: PointerEvent) => {
    if (!editable() || e.button !== 0) return;
    const svg = p.svg();
    if (!svg) return;
    e.preventDefault();
    e.stopPropagation();
    svg.setPointerCapture(e.pointerId);
    setDrag({ player: pl.id, pointer: e.pointerId, pos: pl.state.pos, moved: false });
    p.state.presence({ focus: pl.id });
    const move = (ev: PointerEvent) => {
      const d = drag();
      if (!d || ev.pointerId !== d.pointer) return;
      const pos = clampToMap(viewToWorld(svgPoint(svg, ev), p.vp));
      setDrag({ ...d, pos, moved: true });
      p.state.presence({ drag: { id: d.player, pos }, cursor: pos });
    };
    const up = (ev: PointerEvent) => {
      const d = drag();
      if (!d || ev.pointerId !== d.pointer) return;
      svg.removeEventListener("pointermove", move);
      svg.removeEventListener("pointerup", up);
      svg.removeEventListener("pointercancel", up);
      if (ev.type === "pointerup" && d.moved) p.state.edit([{ Set: { id: d.player, value: { PlayerPos: d.pos } } }]);
      setDrag(undefined);
      p.state.presence({ drag: null, focus: null });
    };
    svg.addEventListener("pointermove", move);
    svg.addEventListener("pointerup", up);
    svg.addEventListener("pointercancel", up);
  };

  return (
    <g class="tokens">
      <For each={players()}>
        {(pl) => {
          const slot = () => slots().get(pl.state.slot)!;
          const hero = () => (slot().hero != null ? p.art.heroes.get(slot().hero!) : undefined);
          const team = () => (slot().team === "Amber" ? "amber" : "sapphire");
          const mine = () => (drag()?.player === pl.id ? drag() : undefined);
          const others = () => touching().get(pl.id) ?? [];
          const remoteDrag = () => others().find((o) => o.state?.drag?.id === pl.id);
          const shown = () => mine()?.pos ?? remoteDrag()?.state?.drag?.pos ?? pl.state.pos;
          const at = () => worldToView(shown(), p.vp);
          const home = () => worldToView(pl.state.pos, p.vp);
          const r = () => TOKEN_R * p.k;
          const label = () => `${slot().name || `${slot().team} ${slot().slot + 1}`}${hero() ? `, ${hero()!.name}` : ""}`;
          return (
            <Show when={pl.state.placed}>
              <Show when={remoteDrag()}>
                {(o) => (
                  <g class="drag-trail" style={{ "--c": colorOf(o().state!.color) }}>
                    <path d={`M${home().x} ${home().y} L${at().x} ${at().y}`} style={{ stroke: colorOf(o().state!.color) }} />
                    <circle cx={home().x} cy={home().y} r={r()} style={{ stroke: colorOf(o().state!.color) }} />
                  </g>
                )}
              </Show>
              <g
                class={`tok ${team()}`}
                classList={{ dead: !pl.state.alive, preview: !!remoteDrag() || !!mine(), dragging: !!mine() }}
                transform={`translate(${at().x} ${at().y})`}
                data-slot={`${slot().team}-${slot().slot}`}
                data-player={pl.id}
                onPointerDown={(e) => down(pl, e)}
              >
                <title>{label()}</title>
                <circle
                  class="body"
                  r={r()}
                  style={
                    remoteDrag()
                      ? { stroke: colorOf(remoteDrag()!.state!.color), "stroke-width": 4 }
                      : hero()?.portrait
                        ? { fill: "#0b1714", stroke: `var(--${team()})`, "stroke-width": 3 }
                        : {}
                  }
                />
                <Show
                  when={hero()?.portrait}
                  fallback={
                    <text style={{ "font-size": `${15 * p.k}px`, display: "inline" }}>{initials(slot(), hero()?.name)}</text>
                  }
                >
                  {(src) => (
                    <image
                      href={src()}
                      x={-r() + 2 * p.k}
                      y={-r() + 2 * p.k}
                      width={2 * r() - 4 * p.k}
                      height={2 * r() - 4 * p.k}
                      style={{ "clip-path": "circle(50%) fill-box", "pointer-events": "none", filter: pl.state.alive ? "none" : "grayscale(1) brightness(0.5)" }}
                    />
                  )}
                </Show>
              </g>
              <For each={others()}>
                {(o, i) => (
                  <>
                    <circle class="p-ring" cx={at().x} cy={at().y} r={r() + 6 * p.k} stroke={colorOf(o.state!.color)} />
                    <NameTag
                      at={{ x: at().x, y: at().y - i() * 32 * p.k }}
                      name={o.state!.name}
                      color={o.state!.color}
                      what={o.state!.drag?.id === pl.id ? "moving" : undefined}
                      k={p.k}
                    />
                  </>
                )}
              </For>
            </Show>
          );
        }}
      </For>
    </g>
  );
}
