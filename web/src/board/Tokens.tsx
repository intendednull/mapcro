// Hero tokens on the map: one per roster slot in the current scene. With the Move tool an
// editor drags a token; while dragging, its position travels through presence (others watch it
// move, with the dragger's name tag), and the drop commits one op (spec §4a).

import { rosterTeamShort, slotTag } from "../map/model";
import { For, Show, createEffect, createMemo, createSignal, on, onCleanup, onMount } from "solid-js";
import { Portal } from "solid-js/web";
import { formatClock, parseClock } from "../core/clock";
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
import { FLIP_MS, smoothed } from "./smooth";
import { hoverToken, hoveredToken, registerHover } from "../map/HoverLabel";
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
  return `${slotTag(slot.team)}${slot.slot + 1}`;
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
/** A small skull: dome, eyes and jaw (eyes and nose are holes, evenodd). */
const SKULL = "M0 -6a6 6 0 0 1 6 6c0 2-1 3-2 3.6V6H-4V3.6C-5 3-6 2-6 0a6 6 0 0 1 6-6zM-2.4 -1.2a1.5 1.5 0 1 0 0.01 0zM2.4 -1.2a1.5 1.5 0 1 0 0.01 0zM0 1.6l-0.9 1.4h1.8z";

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
  const bySlot = createMemo(() => new Map(players().map((pl) => [pl.state.slot, pl])));
  const slotIds = createMemo(() => players().map((pl) => pl.state.slot), undefined, { equals: (a, b) => a.length === b.length && a.every((x, i) => x === b[i]) });
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

  /** Dead or alive (K on a hovered hero, or its skull button). Coming back clears the timer. */
  const toggleAlive = (pl: Player) => {
    if (!p.state.canEdit() || p.preview?.()) return;
    const alive = !pl.state.alive;
    p.state.edit([
      { Set: { id: pl.id, value: { PlayerAlive: alive } } },
      ...(alive && pl.state.respawn != null ? [{ Set: { id: pl.id, value: { PlayerRespawn: null } } } as const] : []),
    ]);
  };
  // K acts on the hero under the pointer: the hover is a hint, and is checked against what is
  // actually under the pointer at the key press (a token that moved, unmounted or flipped
  // scenes leaves no stale target). Never under a match preview, like the skull button.
  const [hovered, setHovered] = createSignal<RecordId>();
  const [timing, setTiming] = createSignal<RecordId>();
  // A dead hero's unset respawn label is an invisible hint over the hero below it in the default
  // layout: it shows, and takes the pointer, only once the pointer came to it from its own hero
  // (armed on entering the token, kept while the pointer stays over the token, its label or the
  // gap between), so the hero below stays grabbable from anywhere else.
  const [armed, setArmed] = createSignal<RecordId>();
  let root: SVGGElement | undefined;
  createEffect(on(() => p.scene, () => setHovered(undefined), { defer: true }));
  onMount(() => {
    let at: { x: number; y: number } | undefined;
    const move = (e: PointerEvent) => {
      at = { x: e.clientX, y: e.clientY };
      const id = armed();
      if (!id) return;
      const box = [root?.querySelector(`.tok[data-player="${id}"]`), labels.querySelector(`[data-player="${id}"]`)].flatMap((el) => (el ? [el.getBoundingClientRect()] : []));
      const inside = box.length > 0 && e.clientX >= Math.min(...box.map((b) => b.left)) && e.clientX <= Math.max(...box.map((b) => b.right)) && e.clientY >= Math.min(...box.map((b) => b.top)) && e.clientY <= Math.max(...box.map((b) => b.bottom));
      if (!inside) setArmed(undefined);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== "k" || e.ctrlKey || e.metaKey || e.altKey || e.repeat || !at || p.preview?.()) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      const under = document.elementsFromPoint(at.x, at.y).map((el) => el.closest?.(".tok[data-player]")?.getAttribute("data-player")).find(Boolean);
      const pl = under === hovered() ? players().find((x) => x.id === under) : undefined;
      if (!pl) return;
      e.preventDefault();
      toggleAlive(pl);
    };
    window.addEventListener("pointermove", move, true);
    window.addEventListener("keydown", key);
    onCleanup(() => {
      window.removeEventListener("pointermove", move, true);
      window.removeEventListener("keydown", key);
    });
  });
  const setRespawn = (pl: Player, text: string) => {
    setTiming(undefined);
    const v = parseClock(text);
    if (v === undefined) return;
    const s = v === null ? null : Math.min(600, v);
    if (s !== (pl.state.respawn ?? null)) p.state.edit([{ Set: { id: pl.id, value: { PlayerRespawn: s } } }]);
  };

  const toggleVision = (pl: Player, e: PointerEvent) => {
    if (!p.state.canEdit() || e.button !== 0 || p.preview?.()) return;
    e.preventDefault();
    e.stopPropagation();
    p.state.edit([{ Set: { id: pl.id, value: { PlayerVisible: !pl.state.visible } } }]);
  };

  // Each dead hero's respawn label hangs below its token, where the next row of heroes stands
  // in the default layout: drawn in its own layer above every token, so no neighbour, whatever
  // its place in the roster, covers it and takes its click.
  const labels = document.createElementNS("http://www.w3.org/2000/svg", "g");
  labels.setAttribute("class", "respawns");

  return (
    <g class="tokens" ref={root}>
      <For each={slotIds()}>
        {(slotId) => {
          // Keyed by roster slot, not by record: a flip keeps each hero's node, and it glides.
          let last: Player | undefined;
          const pl = () => (last = bySlot().get(slotId) ?? last)!;
          const slot = () => slots().get(pl().state.slot)!;
          const pv = () => p.preview?.()?.players.get(slotKey(slot().team, slot().slot));
          // A match preview (Player) draws only the timeline at t, never the scene's records:
          // alive and seen by the match, placed where the match has them (spec §6b).
          const live = () => !!p.preview?.();
          const alive = () => (live() ? true : pl().state.alive);
          const visible = () => (live() ? true : pl().state.visible);
          const heroId = () => pv()?.hero ?? slot().hero;
          const hero = () => (heroId() != null ? p.art.heroes.get(heroId()!) : undefined);
          const team = () => (slot().team === "Amber" ? "amber" : "sapphire");
          const mine = () => {
            const d = drag();
            const g = d?.group.find((x) => x.id === pl().id);
            return d && g ? moved(g.from, d.delta) : undefined;
          };
          const others = () => (touching().get(pl().id) ?? []).map((t) => t.peer);
          const remote = () => (touching().get(pl().id) ?? []).find((t) => t.at);
          const remoteDrag = () => remote()?.peer;
          const remoteAt = smoothed(() => remote()?.at);
          const target = () => pv()?.pos ?? mine() ?? remoteAt() ?? pl().state.pos;
          // A scene flip: from the last scene's spot to this one's (render only).
          const flipped = smoothed(target, FLIP_MS, () => p.scene);
          const shown = () => flipped() ?? target();
          const selected = () => p.selection().has(pl().id);
          const at = () => worldToView(shown(), p.vp);
          const home = () => worldToView(pl().state.pos, p.vp);
          const r = () => TOKEN_R * p.k;
          // In Player, the match's player name (spec §6b); else the board's slot name.
          const label = () => `${pv()?.name || slot().name || `${rosterTeamShort(slot().team)} ${slot().slot + 1}`}${hero() ? `, ${hero()!.name}` : ""}`;
          // The map's hover label (map/HoverLabel.tsx), by roster slot, never the player's id.
          const hoverId = () => `${slot().team}-${slot().slot}`;
          const shownOnMap = () => (live() ? !!pv()?.pos : pl().state.placed);
          const partText = (part: string | undefined) => (part === "vis" ? (visible() ? "In vision" : "Not seen") : part === "life" ? (alive() ? "Kill (K)" : "Revive (K)") : label());
          createEffect(() => {
            const off = registerHover("token", hoverId(), (part) => (shownOnMap() ? { x: at().x, y: at().y, gap: r() + 12 * p.k, text: partText(part) } : undefined));
            onCleanup(off);
          });
          const hover = (part?: string) => hoverToken({ kind: "token", id: hoverId(), part });
          const unhover = () => {
            if (hoveredToken()?.id === hoverId()) hoverToken(undefined);
          };
          onCleanup(unhover);
          return (
            <Show when={live() ? !!pv()?.pos : pl().state.placed}>
              <Show when={remoteDrag()}>
                {(o) => (
                  <g class="drag-trail" style={{ "--c": colorOf(o().state!.color) }}>
                    <path d={`M${home().x} ${home().y} L${at().x} ${at().y}`} style={{ stroke: colorOf(o().state!.color) }} />
                    <circle cx={home().x} cy={home().y} r={r()} style={{ stroke: colorOf(o().state!.color) }} />
                  </g>
                )}
              </Show>
              <g
                class={cx("tok", team(), !alive() && "dead", !visible() && "ghost", selected() && "selected", (!!remoteDrag() || !!mine()) && "preview", !!mine() && "dragging")}
                transform={`translate(${at().x} ${at().y})`}
                data-slot={`${slot().team}-${slot().slot}`}
                data-player={pl().id}
                data-visible={String(visible())}
                onPointerDown={(e) => down(pl(), e)}
                aria-label={label()}
                onPointerEnter={() => {
                  setHovered(pl().id);
                  setArmed(pl().id);
                  hover();
                }}
                onPointerLeave={() => {
                  if (hovered() === pl().id) setHovered(undefined);
                  unhover();
                }}
                // Off the map (a hero that died, a token taken off) with no pointerleave: unhovered.
                ref={() =>
                  onCleanup(() => {
                    if (hovered() === pl().id) setHovered(undefined);
                    unhover();
                  })
                }
              >
                <Show when={selected()}>
                  <circle class="sel" r={r() + 5 * p.k} />
                </Show>
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
                <Show when={pv()?.health != null}>
                  {(_) => {
                    // Player, replay tier: health as an arc round the token (operator, 2026-11-08).
                    // Heavier than the body's stroke so it reads at the default zoom (handoff).
                    const hr = () => r() + 4.5 * p.k;
                    const hp = () => pv()?.health ?? 0;
                    return (
                      <g data-testid="tok-health" data-health={hp()}>
                        <circle class="tok-hp tok-hp-bg" r={hr()} style={{ "stroke-width": `${5 * p.k}` }} />
                        <circle
                          class={cx("tok-hp tok-hp-fill", team(), hp() <= 30 && "low")}
                          r={hr()}
                          transform="rotate(-90)"
                          // Measured as 0..100 so a zoom changes nothing to ease; only health does.
                          pathLength="100"
                          style={{ "stroke-width": `${5 * p.k}`, "stroke-dasharray": `${hp()} 100` }}
                        />
                      </g>
                    );
                  }}
                </Show>
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
                      style={{ "clip-path": "circle(50%) fill-box", "pointer-events": "none", filter: alive() ? "none" : "grayscale(1) brightness(0.5)" }}
                    />
                  )}
                </Show>
                <g
                  class={cx("vis", !visible() && "off", p.state.canEdit() && !live() && "editable")}
                  data-testid="vision"
                  transform={`translate(${r() * 0.78} ${-r() * 0.78}) scale(${p.k})`}
                  onPointerDown={(e) => toggleVision(pl(), e)}
                  aria-label={partText("vis")}
                  onPointerEnter={() => hover("vis")}
                  onPointerLeave={() => hover()}
                >
                  <circle r="9" />
                  <path d={EYE} />
                  <Show when={visible()}>
                    <circle class="pupil" r="1.8" />
                  </Show>
                  <Show when={!visible()}>
                    <path class="slash" d="M-6 6L6 -6" />
                  </Show>
                </g>
                <g
                  class={cx("life", p.state.canEdit() && !live() && "editable")}
                  data-testid="life"
                  aria-label={partText("life")}
                  onPointerEnter={() => hover("life")}
                  onPointerLeave={() => hover()}
                  transform={`translate(${-r() * 0.78} ${-r() * 0.78}) scale(${p.k})`}
                  onPointerDown={(e) => {
                    if (e.button !== 0 || !p.state.canEdit() || live()) return;
                    e.preventDefault();
                    e.stopPropagation();
                    toggleAlive(pl());
                  }}
                >

                  <circle r="9" />
                  <path class="skull" d={SKULL} />
                </g>
                <Show when={!alive()}>
                  <g class="dead-badge" transform={`translate(0 ${r() * 0.55}) scale(${p.k})`}>
                    <circle r="8" />
                    <path class="skull" d={SKULL} />
                  </g>
                </Show>
              </g>
              <Show when={!alive() && !live()}>
                <Portal mount={labels} isSVG>
                  <g class="respawn" data-testid="respawn" data-player={pl().id} transform={`translate(${at().x} ${at().y + r() + 14 * p.k}) scale(${p.k})`}>
                    <Show
                      when={timing() === pl().id}
                      fallback={
                        <g
                          class={cx("respawn-label", p.state.canEdit() && "editable", pl().state.respawn == null && "unset", armed() === pl().id && "hint")}
                          onPointerDown={(e) => {
                            if (e.button !== 0 || !p.state.canEdit()) return;
                            e.preventDefault();
                            e.stopPropagation();
                            setTiming(pl().id);
                          }}
                        >
                          <rect x="-44" y="-10" width="88" height="20" rx="4" />
                          <text>{pl().state.respawn != null ? `respawn ${formatClock(pl().state.respawn)}` : "respawn"}</text>
                        </g>
                      }
                    >
                      <foreignObject x="-44" y="-12" width="88" height="24">
                        <input
                          class="respawn-input"
                          data-testid="respawn-input"
                          aria-label="Respawn in (m:ss)"
                          value={formatClock(pl().state.respawn)}
                          ref={(el) => queueMicrotask(() => el.select())}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") setRespawn(pl(), e.currentTarget.value);
                            if (e.key === "Escape") setTiming(undefined);
                            e.stopPropagation();
                          }}
                          onBlur={(e) => timing() === pl().id && setRespawn(pl(), e.currentTarget.value)}
                        />
                      </foreignObject>
                    </Show>
                  </g>
                </Portal>
              </Show>
              <For each={others()}>
                {(o, i) => (
                  <>
                    <circle class="p-ring" cx={at().x} cy={at().y} r={r() + 6 * p.k} stroke={colorOf(o.state!.color)} />
                    <NameTag
                      at={{ x: at().x, y: at().y - i() * 32 * p.k }}
                      name={o.state!.name}
                      color={o.state!.color}
                      what={o.state!.drag?.id === pl().id || o.state!.drag_group?.includes(pl().id) ? "moving" : undefined}
                      k={p.k}
                    />
                  </>
                )}
              </For>
            </Show>
          );
        }}
      </For>
      {labels}
    </g>
  );
}
