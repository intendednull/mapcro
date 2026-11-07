// The board's own layers over the minimap, and every gesture the tools make on it
// (spec §4: the map is the interface, the picker only chooses the gesture):
//
//   Move     drag heroes and callouts, click objectives to cycle them, double-click a callout to edit
//   Draw     freehand ink in the palette colour            → one Stroke
//   Arrow    drag out a rotation arrow (team from the hero it starts on) → one Arrow
//   Callout  click to place a label, typed in place        → one Callout
//   Laser    a trail others see, fading; presence only, viewers too
//   Erase    click or scrub over ink, arrows and callouts  → one transaction of deletes
//
// Layer order (design/parity/README.md, layer 10): arrows, ink and callouts, drag ghosts, hero
// tokens, then lasers, cursors and name tags.

import { For, Show, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { colorOf } from "../core/device";
import type { Arrow } from "../gen/Arrow";
import type { Callout } from "../gen/Callout";
import type { ObjectiveStatus } from "../gen/ObjectiveStatus";
import type { Op } from "../gen/Op";
import type { PeerPresence } from "../gen/PeerPresence";
import type { RecordId } from "../gen/RecordId";
import type { Stroke } from "../gen/Stroke";
import type { WorldPos } from "../gen/WorldPos";
import { HUD_PX } from "../map/model";
import type { Art } from "../map/pack";
import { type Pt, type Viewpoint, clampToMap, mapToView, viewToWorld, worldToView } from "../map/transform";
import { newRecordId } from "../wasm/mapcro_wasm.js";
import { cx } from "../ui/cx";
import { LASER_MAX_POINTS, type Timed, arrowHead, fitStroke, laserOpacity, polyline, pruneLaser, shaftEnd } from "./geometry";
import type { BoardState } from "./state";
import type { Tool } from "./tools";
import { NameTag, Tokens, svgPoint } from "./Tokens";
import { Cursors } from "./Presence";

export const INK_WIDTH = 60; // tenths: 6 map units, the design's ink
const MAX_STROKE_POINTS = 512;
const MAX_CALLOUT = 80;
const CYCLE: Record<ObjectiveStatus, ObjectiveStatus> = { Active: "Destroyed", Destroyed: "Hidden", Hidden: "Active" };

type Rec<T> = { id: RecordId; r: T };

function textWidth(s: string, px: number) {
  return Math.max(40, s.length * px * 0.56 + 28);
}

export function Layers(p: {
  state: BoardState;
  art: Art;
  vp: Viewpoint;
  scene: RecordId | undefined;
  tool: Tool;
  ink: number;
  myColor: number;
  svg: () => SVGSVGElement | undefined;
  /** Objective statuses in this scene, by key (absent = active). */
  objectives: () => Map<string, { id: RecordId; status: ObjectiveStatus }>;
  /** Zoom scale (view width / 1000): tokens, tags and cursors keep their screen size. */
  k: number;
  /** Move tool on empty map: pan by this much (view units). */
  onPan: (dx: number, dy: number) => void;
  /** Wheel: zoom about a point (view units); factor > 1 zooms out. */
  onZoom: (at: Pt, factor: number) => void;
  /** Phone: callouts as numbered pins, their text listed under the map. */
  compactCallouts?: boolean;
}) {
  const st = p.state;
  const view = (w: WorldPos) => worldToView(w, p.vp);
  const world = (v: Pt) => clampToMap(viewToWorld(v, p.vp));
  const editor = () => st.canEdit();

  const strokes = createMemo(() => st.inScene("Stroke", p.scene).map(([id, r]) => ({ id, r: (r as { Stroke: Stroke }).Stroke })));
  const arrows = createMemo(() => st.inScene("Arrow", p.scene).map(([id, r]) => ({ id, r: (r as { Arrow: Arrow }).Arrow })));
  const callouts = createMemo(() => calloutOrder(st.inScene("Callout", p.scene)).map((c) => ({ id: c.id, r: c.r })));
  const teamOfSlot = createMemo(() => new Map(st.roster().map((s) => [s.id, s.slot.team])));

  // Others' drags and focus by record (callouts here; tokens do their own).
  const touching = createMemo(() => {
    const m = new Map<RecordId, PeerPresence[]>();
    for (const peer of st.peerList()) {
      const id = peer.state!.drag?.id ?? peer.state!.focus;
      if (id) m.set(id, [...(m.get(id) ?? []), peer]);
    }
    return m;
  });

  // In-progress gestures (local only, except the laser and drags, which go through presence).
  const [drawing, setDrawing] = createSignal<Pt[]>();
  const [arrowing, setArrowing] = createSignal<{ from: Pt; to: Pt; team: "Amber" | "Sapphire" | null }>();
  const [erasing, setErasing] = createSignal<Set<RecordId>>(new Set());
  const [dragCallout, setDragCallout] = createSignal<{ id: RecordId; pos: WorldPos }>();
  const [editing, setEditing] = createSignal<{ id: RecordId | undefined; pos: WorldPos; text: string }>();
  const [laser, setLaser] = createSignal<Timed[]>([]);

  // ---- laser: a local trail of timed points, pruned on a ticker and shared as presence ----
  let laserTick: ReturnType<typeof setInterval> | undefined;
  const pushLaser = (pt: Pt) => {
    const now = performance.now();
    setLaser(pruneLaser([...laser(), { p: pt, t: now }], now));
    st.presence({ laser: laser().map((q) => world(q.p)) });
    if (!laserTick)
      laserTick = setInterval(() => {
        const next = pruneLaser(laser(), performance.now());
        if (next.length !== laser().length) {
          setLaser(next);
          st.presence({ laser: next.map((q) => world(q.p)) });
        }
        if (next.length === 0) {
          clearInterval(laserTick);
          laserTick = undefined;
        }
      }, 50);
  };
  onCleanup(() => clearInterval(laserTick));

  // ---- one pointer gesture on the map, captured until release ----
  const track = (e: PointerEvent, move: (pt: Pt, ev: PointerEvent) => void, up: (pt: Pt, ok: boolean) => void) => {
    const svg = p.svg();
    if (!svg) return;
    svg.setPointerCapture(e.pointerId);
    const onMove = (ev: PointerEvent) => ev.pointerId === e.pointerId && move(svgPoint(svg, ev), ev);
    const onUp = (ev: PointerEvent) => {
      if (ev.pointerId !== e.pointerId) return;
      svg.removeEventListener("pointermove", onMove);
      svg.removeEventListener("pointerup", onUp);
      svg.removeEventListener("pointercancel", onUp);
      up(svgPoint(svg, ev), ev.type === "pointerup");
    };
    svg.addEventListener("pointermove", onMove);
    svg.addEventListener("pointerup", onUp);
    svg.addEventListener("pointercancel", onUp);
  };

  const erasableAt = (ev: PointerEvent) => {
    for (const el of document.elementsFromPoint(ev.clientX, ev.clientY)) {
      const id = (el as HTMLElement).closest?.("[data-erase]")?.getAttribute("data-erase");
      if (id) return id;
    }
    return undefined;
  };

  /** The objective marker under a point (view units), nearest first. */
  const objectiveAt = (pt: Pt) => {
    let best: { key: string; d: number } | undefined;
    for (const m of p.art.model.markers) {
      if (m.kind === "camp" || m.kind === "koth" || m.kind === "midboss") continue;
      const at = mapToView(m.at, p.vp);
      const d = Math.hypot(at.x - pt.x, at.y - pt.y);
      if (d <= Math.max(18, (m.px * HUD_PX) / 2.6) && (!best || d < best.d)) best = { key: m.key, d };
    }
    return best?.key;
  };

  const cycleObjective = (key: string) => {
    const scene = p.scene;
    if (!scene) return;
    const cur = p.objectives().get(key);
    if (cur) st.edit([{ Set: { id: cur.id, value: { ObjectiveStatus: CYCLE[cur.status] } } }]);
    else st.edit([{ Create: { id: newRecordId(), record: { ObjectiveState: { scene, key, status: "Destroyed" } } } }]);
  };

  const down = (e: PointerEvent) => {
    if (e.button !== 0 || !p.scene) return;
    const svg = p.svg();
    if (!svg) return;
    const start = svgPoint(svg, e);
    const tool = p.tool;
    if (tool === "laser") {
      e.preventDefault();
      pushLaser(start);
      track(e, (pt) => pushLaser(pt), () => {});
      return;
    }
    if (tool === "move") {
      const key = editor() ? objectiveAt(start) : undefined;
      e.preventDefault();
      // Drag on empty map pans; a click on an objective (editors) cycles it.
      const perPx = 1000 / svg.getBoundingClientRect().width;
      let last = { x: e.clientX, y: e.clientY };
      let travelled = 0;
      const onMove = (ev: PointerEvent) => {
        if (ev.pointerId !== e.pointerId) return;
        const dx = ev.clientX - last.x;
        const dy = ev.clientY - last.y;
        travelled += Math.abs(dx) + Math.abs(dy);
        last = { x: ev.clientX, y: ev.clientY };
        if (travelled > 4) p.onPan(dx * perPx, dy * perPx);
      };
      svg.addEventListener("pointermove", onMove);
      track(
        e,
        () => {},
        (_, ok) => {
          svg.removeEventListener("pointermove", onMove);
          if (ok && key && travelled <= 4) cycleObjective(key);
        },
      );
      return;
    }
    if (!editor()) return;
    if (tool === "draw") {
      e.preventDefault();
      setDrawing([start]);
      track(
        e,
        (pt) => setDrawing([...(drawing() ?? []), pt]),
        (_, ok) => {
          const pts = drawing() ?? [];
          setDrawing(undefined);
          if (!ok || pts.length === 0) return;
          const fitted = fitStroke(pts, MAX_STROKE_POINTS);
          // A tap is a dot: the schema wants at least two points, so the dot repeats its one.
          const points = (fitted.length === 1 ? [fitted[0]!, fitted[0]!] : fitted).map(world);
          st.edit([{ Create: { id: newRecordId(), record: { Stroke: { scene: p.scene!, points, color: p.ink, width: INK_WIDTH } } } }]);
        },
      );
    } else if (tool === "arrow") {
      e.preventDefault();
      // Starting on a hero: the arrow takes that hero's team and starts at its centre.
      const tok = (e.target as Element).closest?.(".tok[data-player]");
      const pid = tok?.getAttribute("data-player");
      const rec = pid ? st.records[pid] : undefined;
      let from = start;
      let team: "Amber" | "Sapphire" | null = null;
      if (rec && "PlayerState" in rec.record) {
        from = view(rec.record.PlayerState.pos);
        team = teamOfSlot().get(rec.record.PlayerState.slot) ?? null;
      }
      setArrowing({ from, to: from, team });
      track(
        e,
        (pt) => setArrowing({ ...arrowing()!, to: pt }),
        (_, ok) => {
          const a = arrowing();
          setArrowing(undefined);
          if (!ok || !a || Math.hypot(a.to.x - a.from.x, a.to.y - a.from.y) < 12) return;
          st.edit([{ Create: { id: newRecordId(), record: { Arrow: { scene: p.scene!, from: world(a.from), to: world(a.to), team: a.team } } } }]);
        },
      );
    } else if (tool === "callout") {
      e.preventDefault();
      const hit = (e.target as Element).closest?.("[data-callout]")?.getAttribute("data-callout");
      const c = hit ? callouts().find((x) => x.id === hit) : undefined;
      openEditor(c ? { id: c.id, pos: c.r.pos, text: c.r.text } : { id: undefined, pos: world(start), text: "" });
    } else if (tool === "erase") {
      e.preventDefault();
      const hits = new Set<RecordId>();
      const add = (ev: PointerEvent) => {
        const id = erasableAt(ev);
        if (id && !hits.has(id)) {
          hits.add(id);
          setErasing(new Set(hits));
        }
      };
      add(e);
      track(
        e,
        (_, ev) => add(ev),
        (_, ok) => {
          setErasing(new Set<RecordId>());
          if (ok && hits.size) st.edit([...hits].map((id): Op => ({ Delete: { id } })));
        },
      );
    }
  };

  onMount(() => {
    const svg = p.svg();
    if (!svg) return;
    // Your cursor, for everyone looking at the same scene.
    const cursor = (e: PointerEvent) => st.presence({ cursor: world(svgPoint(svg, e)) });
    const leave = () => st.presence({ cursor: null });
    const wheel = (e: WheelEvent) => {
      if (e.ctrlKey && Math.abs(e.deltaY) < 1) return;
      e.preventDefault();
      p.onZoom(svgPoint(svg, e), Math.exp(Math.max(-1, Math.min(1, e.deltaY / 300))));
    };
    svg.addEventListener("pointerdown", down);
    svg.addEventListener("pointermove", cursor);
    svg.addEventListener("pointerleave", leave);
    svg.addEventListener("wheel", wheel, { passive: false });
    onCleanup(() => {
      svg.removeEventListener("pointerdown", down);
      svg.removeEventListener("pointermove", cursor);
      svg.removeEventListener("pointerleave", leave);
      svg.removeEventListener("wheel", wheel);
    });
  });

  // ---- callouts: drag (Move), edit in place (double-click, or the Callout tool) ----
  const openEditor = (ed: { id: RecordId | undefined; pos: WorldPos; text: string }) => {
    setEditing(ed);
    st.presence({ focus: ed.id ?? null });
  };
  const closeEditor = (commit: boolean, text?: string) => {
    const ed = editing();
    setEditing(undefined);
    st.presence({ focus: null });
    if (!commit || !ed || !p.scene) return;
    const t = (text ?? "").trim().slice(0, MAX_CALLOUT);
    if (ed.id === undefined) {
      if (t) st.edit([{ Create: { id: newRecordId(), record: { Callout: { scene: p.scene, pos: ed.pos, text: t } } } }]);
    } else if (!t) st.edit([{ Delete: { id: ed.id } }]);
    else if (t !== ed.text) st.edit([{ Set: { id: ed.id, value: { CalloutText: t } } }]);
  };

  // Double-click by hand: the drag captures the pointer on the map, so the callout itself never
  // receives a dblclick event.
  let lastTap: { id: RecordId; t: number } | undefined;
  const calloutDown = (c: Rec<Callout>, e: PointerEvent) => {
    if (p.tool !== "move" || !editor() || e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    const svg = p.svg()!;
    const start = svgPoint(svg, e);
    const grab = view(c.r.pos);
    let moved = false;
    st.presence({ focus: c.id });
    track(
      e,
      (pt) => {
        if (!moved && Math.hypot(pt.x - start.x, pt.y - start.y) < 4) return;
        moved = true;
        const pos = world({ x: grab.x + pt.x - start.x, y: grab.y + pt.y - start.y });
        setDragCallout({ id: c.id, pos });
        st.presence({ drag: { id: c.id, pos } });
      },
      (_, ok) => {
        const d = dragCallout();
        setDragCallout(undefined);
        st.presence({ drag: null, focus: null });
        if (ok && moved && d) st.edit([{ Set: { id: c.id, value: { CalloutPos: d.pos } } }]);
        if (ok && !moved) {
          const now = performance.now();
          if (lastTap?.id === c.id && now - lastTap.t < 450) {
            lastTap = undefined;
            openEditor({ id: c.id, pos: c.r.pos, text: c.r.text });
          } else lastTap = { id: c.id, t: now };
        }
      },
    );
  };

  const arrowClass = (team: Arrow["team"]) => (team === "Amber" ? "amber" : team === "Sapphire" ? "sapphire" : "neutral");

  const remoteLasers = createMemo(() => st.peerList().filter((x) => (x.state?.laser.length ?? 0) > 0 && x.state?.scene === p.scene));

  return (
    <>
      <g class="arrows">
        <For each={arrows()}>
          {(a) => {
            const f = () => view(a.r.from);
            const t = () => view(a.r.to);
            return (
              <g class={cx("arrow", erasing().has(a.id) && "erasing")} data-erase={a.id} data-arrow={a.id}>
                <path class="hit" d={`M${f().x} ${f().y} L${t().x} ${t().y}`} />
                <path class={cx("arw", arrowClass(a.r.team))} d={polyline([f(), shaftEnd(f(), t(), 10)])} />
                <polygon class={cx("head", arrowClass(a.r.team))} points={arrowHead(f(), t(), 22)} />
              </g>
            );
          }}
        </For>
        <Show when={arrowing()}>
          {(a) => (
            <g class="arrow preview">
              <path class={cx("arw", arrowClass(a().team))} d={polyline([a().from, shaftEnd(a().from, a().to, 10)])} />
              <polygon class={cx("head", arrowClass(a().team))} points={arrowHead(a().from, a().to, 22)} />
            </g>
          )}
        </Show>
      </g>
      <g class="inks">
        <For each={strokes()}>
          {(s) => {
            const d = () => polyline(s.r.points.map(view));
            return (
              <g data-erase={s.id} data-stroke={s.id} class={cx(erasing().has(s.id) && "erasing")}>
                <path class="hit" d={d()} />
                <path class={cx("ink", erasing().has(s.id) && "erasing")} d={d()} stroke={colorOf(s.r.color)} style={{ "stroke-width": `${s.r.width / 10}` }} />
              </g>
            );
          }}
        </For>
        <Show when={drawing()}>{(pts) => <path class="ink preview" d={polyline(pts())} stroke={colorOf(p.ink)} style={{ "stroke-width": `${INK_WIDTH / 10}` }} />}</Show>
      </g>
      <g class="callouts">
        <For each={callouts()}>
          {(c) => {
            const others = () => touching().get(c.id) ?? [];
            const remote = () => others().find((o) => o.state?.drag?.id === c.id)?.state?.drag?.pos;
            const pos = () => view(dragCallout()?.id === c.id ? dragCallout()!.pos : (remote() ?? c.r.pos));
            const w = () => textWidth(c.r.text, 18);
            const left = () => pos().x + 16 + w() > 1000;
            const bx = () => (left() ? pos().x - 16 - w() : pos().x + 16);
            const by = () => pos().y - 56;
            const hidden = () => editing()?.id === c.id;
            if (p.compactCallouts)
              return (
                <g class="co-pin" data-callout={c.id} transform={`translate(${pos().x} ${pos().y}) scale(${p.k})`}>
                  <circle r="16" />
                  <text>{callouts().findIndex((x) => x.id === c.id) + 1}</text>
                </g>
              );
            return (
              <g
                class={cx("co", erasing().has(c.id) && "erasing", others().length > 0 && "touched")}
                data-erase={c.id}
                data-callout={c.id}
                style={{ opacity: hidden() ? 0.25 : undefined }}
                onPointerDown={(e) => calloutDown(c, e)}
              >
                <path d={`M${pos().x} ${pos().y} L${left() ? bx() + w() : bx()} ${by() + 18}`} stroke="var(--brass)" stroke-width="1.5" />
                <circle class="pin" cx={pos().x} cy={pos().y} r="6" />
                <rect x={bx()} y={by()} width={w()} height="37" rx="6" />
                <text x={bx() + 14} y={by() + 19} style={{ "font-size": "18px" }}>
                  {c.r.text}
                </text>
                <For each={others()}>
                  {(o, i) => (
                    <>
                      <rect class="p-outline" x={bx() - 4} y={by() - 4} width={w() + 8} height="45" rx="9" stroke={colorOf(o.state!.color)} />
                      <NameTag
                        at={{ x: bx() - 30, y: by() + 10 - i() * 32 }}
                        name={o.state!.name}
                        color={o.state!.color}
                        what={o.state!.drag?.id === c.id ? "moving" : "editing"}
                        k={1}
                      />
                    </>
                  )}
                </For>
              </g>
            );
          }}
        </For>
        <Show when={editing()}>
          {(ed) => {
            const pos = () => view(ed().pos);
            const x = () => Math.min(pos().x + 16, 1000 - 300);
            return (
              <g class="co editing">
                <circle class="pin" cx={pos().x} cy={pos().y} r="6" />
                <foreignObject x={x()} y={pos().y - 60} width="300" height="44">
                  <input
                    class="callout-input"
                    data-testid="callout-input"
                    aria-label="Callout text"
                    maxLength={MAX_CALLOUT}
                    value={ed().text}
                    placeholder="Type a callout, Enter to place"
                    ref={(el) => queueMicrotask(() => el.focus())}
                    onPointerDown={(e) => e.stopPropagation()}
                    onKeyDown={(e) => {
                      e.stopPropagation();
                      if (e.key === "Enter") closeEditor(true, e.currentTarget.value);
                      if (e.key === "Escape") closeEditor(false);
                    }}
                    onBlur={(e) => editing() && closeEditor(true, e.currentTarget.value)}
                  />
                </foreignObject>
              </g>
            );
          }}
        </Show>
      </g>
      <Tokens state={st} art={p.art} vp={p.vp} scene={p.scene} tool={p.tool} k={p.k} svg={p.svg} />
      <g class="lasers">
        <For each={remoteLasers()}>
          {(peer) => <LaserTrail points={peer.state!.laser.map(view)} color={colorOf(peer.state!.color)} name={peer.state!.name} />}
        </For>
        <Show when={laser().length > 0}>
          <LaserTrail points={laser().map((q) => q.p)} color={colorOf(p.myColor)} mine />
        </Show>
      </g>
      <Cursors peers={st.peerList()} scene={p.scene} vp={p.vp} k={p.k} />
    </>
  );
}

function LaserTrail(p: { points: Pt[]; color: string; name?: string; mine?: boolean }) {
  const segs = () => p.points.slice(1).map((q, i) => ({ a: p.points[i]!, b: q, i }));
  const head = () => p.points[p.points.length - 1];
  return (
    <g class="laser" style={{ "--c": p.color }} data-laser={p.mine ? "mine" : (p.name ?? "")}>
      <For each={segs()}>
        {(s) => (
          <path
            d={`M${s.a.x} ${s.a.y} L${s.b.x} ${s.b.y}`}
            style={{ opacity: laserOpacity(s.i, segs().length), "stroke-width": `${5 + 4 * laserOpacity(s.i, segs().length)}px` }}
          />
        )}
      </For>
      <Show when={head()}>{(h) => <circle class="head" cx={h().x} cy={h().y} r="7" />}</Show>
    </g>
  );
}

export { LASER_MAX_POINTS };

/** Callouts in a stable order (by id), so the phone's numbered pins match its list. */
export function calloutOrder(rows: Array<readonly [RecordId, unknown]>): Array<{ id: RecordId; r: Callout; text: string }> {
  return rows
    .flatMap(([id, r]) => (r && typeof r === "object" && "Callout" in r ? [{ id, r: (r as { Callout: Callout }).Callout }] : []))
    .sort((a, b) => (a.id < b.id ? -1 : 1))
    .map((c) => ({ ...c, text: c.r.text }));
}
