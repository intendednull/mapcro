// Hero tokens on the map: one per roster slot in the current scene. With the Move tool an
// editor drags a token; while dragging, its position travels through presence (others watch it
// move, with the dragger's name tag), and the drop commits one op (spec §4a).

import { For, Show, createMemo, createSignal } from "solid-js";
import { capture } from "../ui/capture";
import { cx } from "../ui/cx";
import type { MatchPreview } from "../match/MatchPanel";
import { slotKey } from "../match/save";
import { colorOf } from "../core/device";
import type { PeerPresence } from "../gen/PeerPresence";
import type { RecordId } from "../gen/RecordId";
import type { WorldPos } from "../gen/WorldPos";
import type { Art } from "../map/pack";
import { type Pt, type Viewpoint, clampToMap, viewToWorld, worldToView } from "../map/transform";
import { smoothed } from "./smooth";
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
  /** The token under the pointer. */
  player: RecordId;
  pointer: number;
  /** Everyone moving: the grabbed token and the rest of the selection, with where they started. */
  group: Array<{ id: RecordId; from: WorldPos }>;
  start: WorldPos;
  delta: { x: number; y: number };
  moved: boolean;
}

const EYE = "M-6 0s2.4-4 6-4 6 4 6 4-2.4 4-6 4-6-4-6-4z";

export function Tokens(p: {
  state: BoardState;
  art: Art;
  vp: Viewpoint;
  scene: RecordId | undefined;
  tool: string;
  /** Marker scale for zoom: tokens keep their on-screen size. */
  k: number;
  svg: () => SVGSVGElement | undefined;
  selection: () => Set<RecordId>;
  setSelection: (s: Set<RecordId>) => void;
  /** A press on a hero ends an objective group selection. */
  onPress?: () => void;
  /** A match preview: heroes at the match's positions (by "amber-0"…), dead ones hidden. */
  preview?: (() => MatchPreview | undefined) | undefined;
}) {
  const [drag, setDrag] = createSignal<Drag | undefined>();
  const slots = createMemo(() => new Map(p.state.roster().map((s) => [s.id, s.slot])));
  const players = createMemo(() => p.state.playersIn(p.scene).filter((pl) => slots().has(pl.state.slot)));
  const posOf = (id: RecordId) => {
    const e = p.state.records[id];
    return e && "PlayerState" in e.record ? e.record.PlayerState.pos : undefined;
  };
  const moved = (from: WorldPos, d: { x: number; y: number }) => clampToMap({ x: from.x + d.x, y: from.y + d.y });

  /** Others' drags (and the groups moving with them) and focus, by the record they touch. */
  const touching = createMemo(() => {
    const m = new Map<RecordId, { peer: PeerPresence; at: WorldPos | undefined }[]>();
    const add = (id: RecordId, peer: PeerPresence, at: WorldPos | undefined) => m.set(id, [...(m.get(id) ?? []), { peer, at }]);
    for (const peer of p.state.peerList()) {
      const s = peer.state!;
      if (s.drag) {
        add(s.drag.id, peer, s.drag.pos);
        const from = posOf(s.drag.id);
        if (from) {
          const d = { x: s.drag.pos.x - from.x, y: s.drag.pos.y - from.y };
          for (const id of s.drag_group ?? []) {
            const q = posOf(id);
            if (q) add(id, peer, moved(q, d));
          }
        }
      } else if (s.focus) add(s.focus, peer, undefined);
    }
    return m;
  });

  const editable = () => p.tool === "move" && p.state.canEdit() && !p.preview?.();

  const down = (pl: Player, e: PointerEvent) => {
    if (!editable() || e.button !== 0) return;
    const svg = p.svg();
    if (!svg) return;
    e.preventDefault();
    e.stopPropagation();
    p.onPress?.();
    const sel = p.selection();
    if (e.shiftKey) {
      // Shift-click adds a hero to the selection, or takes it out.
      const next = new Set(sel);
      if (next.has(pl.id)) next.delete(pl.id);
      else next.add(pl.id);
      p.setSelection(next);
      return;
    }
    const ids = sel.has(pl.id) ? [...sel] : [pl.id];
    if (!sel.has(pl.id) && sel.size) p.setSelection(new Set());
    const group = ids.flatMap((id) => {
      const from = posOf(id);
      return from ? [{ id, from }] : [];
    });
    capture(svg, e.pointerId);
    const start = clampToMap(viewToWorld(svgPoint(svg, e), p.vp));
    setDrag({ player: pl.id, pointer: e.pointerId, group, start, delta: { x: 0, y: 0 }, moved: false });
    p.state.presence({ focus: pl.id });
    const move = (ev: PointerEvent) => {
      const d = drag();
      if (!d || ev.pointerId !== d.pointer) return;
      const at = clampToMap(viewToWorld(svgPoint(svg, ev), p.vp));
      const delta = { x: at.x - d.start.x, y: at.y - d.start.y };
      setDrag({ ...d, delta, moved: true });
      const me = d.group.find((g) => g.id === d.player)!;
      p.state.presence({ drag: { id: d.player, pos: moved(me.from, delta) }, drag_group: d.group.filter((g) => g.id !== d.player).map((g) => g.id), cursor: at });
    };
    const up = (ev: PointerEvent) => {
      const d = drag();
      if (!d || ev.pointerId !== d.pointer) return;
      svg.removeEventListener("pointermove", move);
      svg.removeEventListener("pointerup", up);
      svg.removeEventListener("pointercancel", up);
      // The whole group lands as one transaction: one undo step.
      if (ev.type === "pointerup" && d.moved)
        p.state.edit(d.group.map((g) => ({ Set: { id: g.id, value: { PlayerPos: moved(g.from, d.delta) } } })));
      setDrag(undefined);
      p.state.presence({ drag: null, drag_group: [], focus: null });
    };
    svg.addEventListener("pointermove", move);
    svg.addEventListener("pointerup", up);
    svg.addEventListener("pointercancel", up);
  };

  const toggleVision = (pl: Player, e: PointerEvent) => {
    if (!p.state.canEdit() || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    p.state.edit([{ Set: { id: pl.id, value: { PlayerVisible: !pl.state.visible } } }]);
  };

  return (
    <g class="tokens">
      <For each={players()}>
        {(pl) => {
          const slot = () => slots().get(pl.state.slot)!;
          const pv = () => p.preview?.()?.players.get(slotKey(slot().team, slot().slot));
          const heroId = () => pv()?.hero ?? slot().hero;
          const hero = () => (heroId() != null ? p.art.heroes.get(heroId()!) : undefined);
          const team = () => (slot().team === "Amber" ? "amber" : "sapphire");
          const mine = () => {
            const d = drag();
            const g = d?.group.find((x) => x.id === pl.id);
            return d && g ? moved(g.from, d.delta) : undefined;
          };
          const others = () => (touching().get(pl.id) ?? []).map((t) => t.peer);
          const remote = () => (touching().get(pl.id) ?? []).find((t) => t.at);
          const remoteDrag = () => remote()?.peer;
          const remoteAt = smoothed(() => remote()?.at);
          const shown = () => pv()?.pos ?? mine() ?? remoteAt() ?? pl.state.pos;
          const selected = () => p.selection().has(pl.id);
          const at = () => worldToView(shown(), p.vp);
          const home = () => worldToView(pl.state.pos, p.vp);
          const r = () => TOKEN_R * p.k;
          const label = () => `${slot().name || `${slot().team} ${slot().slot + 1}`}${hero() ? `, ${hero()!.name}` : ""}`;
          return (
            <Show when={pl.state.placed && (!p.preview?.() || pv()?.pos)}>
              <Show when={remoteDrag()}>
                {(o) => (
                  <g class="drag-trail" style={{ "--c": colorOf(o().state!.color) }}>
                    <path d={`M${home().x} ${home().y} L${at().x} ${at().y}`} style={{ stroke: colorOf(o().state!.color) }} />
                    <circle cx={home().x} cy={home().y} r={r()} style={{ stroke: colorOf(o().state!.color) }} />
                  </g>
                )}
              </Show>
              <g
                class={cx("tok", team(), !pl.state.alive && "dead", !pl.state.visible && "ghost", selected() && "selected", (!!remoteDrag() || !!mine()) && "preview", !!mine() && "dragging")}
                transform={`translate(${at().x} ${at().y})`}
                data-slot={`${slot().team}-${slot().slot}`}
                data-player={pl.id}
                data-visible={String(pl.state.visible)}
                onPointerDown={(e) => down(pl, e)}
              >
                <Show when={selected()}>
                  <circle class="sel" r={r() + 5 * p.k} />
                </Show>
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
                <g
                  class={cx("vis", !pl.state.visible && "off", p.state.canEdit() && "editable")}
                  data-testid="vision"
                  transform={`translate(${r() * 0.78} ${-r() * 0.78}) scale(${p.k})`}
                  onPointerDown={(e) => toggleVision(pl, e)}
                >
                  <title>{pl.state.visible ? "In vision" : "Not seen"}</title>
                  <circle r="9" />
                  <path d={EYE} />
                  <Show when={pl.state.visible}>
                    <circle class="pupil" r="1.8" />
                  </Show>
                  <Show when={!pl.state.visible}>
                    <path class="slash" d="M-6 6L6 -6" />
                  </Show>
                </g>
              </g>
              <For each={others()}>
                {(o, i) => (
                  <>
                    <circle class="p-ring" cx={at().x} cy={at().y} r={r() + 6 * p.k} stroke={colorOf(o.state!.color)} />
                    <NameTag
                      at={{ x: at().x, y: at().y - i() * 32 * p.k }}
                      name={o.state!.name}
                      color={o.state!.color}
                      what={o.state!.drag?.id === pl.id || o.state!.drag_group?.includes(pl.id) ? "moving" : undefined}
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
