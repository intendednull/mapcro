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
import { capture } from "../ui/capture";
import { colorOf } from "../core/device";
import type { Arrow } from "../gen/Arrow";
import type { Callout } from "../gen/Callout";
import type { ObjectiveStatus } from "../gen/ObjectiveStatus";
import type { Op } from "../gen/Op";
import type { PeerPresence } from "../gen/PeerPresence";
import type { RecordId } from "../gen/RecordId";
import type { Stroke } from "../gen/Stroke";
import type { WorldPos } from "../gen/WorldPos";
import { HUD_PX, type Marker, laneStroke } from "../map/model";
import { pathOf, pointAt, project, splitAt } from "../map/lanes";
import { LANE_GAP } from "../map/MapView";
import { groupToggleOps, marqueePick, toggleOps } from "./objectives";
import type { Art } from "../map/pack";
import { type Pt, type Viewpoint, clampToMap, mapToView, mapToWorld, viewToMap, viewToWorld, worldToMap, worldToView } from "../map/transform";
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

type Rec<T> = { id: RecordId; r: T };

/** A small speech bubble whose tail points at the comment's spot (the origin). */
const BUBBLE = "M0 0 L-4 -8 H-11 A5 5 0 0 1 -16 -13 V-25 A5 5 0 0 1 -11 -30 H11 A5 5 0 0 1 16 -25 V-13 A5 5 0 0 1 11 -8 H4 Z";

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
  /** Selected heroes (Move): a drag on any of them moves them all. */
  selection: () => Set<RecordId>;
  setSelection: (s: Set<RecordId>) => void;
  /** Space is held: a drag pans. */
  spaceHeld: () => boolean;
  showHidden: boolean;
  /** Lane splits recorded in this scene, by lane key. */
  waves: () => Map<string, { id: RecordId; t: number }>;
  /** The split this person is dragging right now. */
  waveDrag: () => { key: string; t: number; id: RecordId } | undefined;
  setWaveDrag: (w: { key: string; t: number; id: RecordId } | undefined) => void;
  /** Effective split per lane key (recorded, previewed, or the default). */
  splitOf: (key: string) => number;
  /** Objectives selected as a group (Move, editors), by key. */
  objSelection: () => Set<string>;
  setObjSelection: (s: Set<string>) => void;
  /** Comments: whether one shows as its full card, and this person's open one. */
  isOpen: (id: RecordId) => boolean;
  openComment: () => RecordId | undefined;
  setOpenComment: (id: RecordId | undefined) => void;
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
  const [box, setBox] = createSignal<{ a: Pt; b: Pt }>();
  /** Others' objective selections (same scene): a ring on each, one name tag on the group. */
  const othersPicks = createMemo(() =>
    st.peerList().flatMap((peer) => {
      const keys = new Set(peer.state?.picked ?? []);
      if (!keys.size || peer.state?.scene !== p.scene) return [];
      const at = p.art.model.markers
        .filter((m) => keys.has(m.key))
        .map((m) => ({ ...mapToView(m.at, p.vp), r: Math.max(14, m.px * HUD_PX * 0.3) * p.k }));
      if (!at.length) return [];
      const top = at.reduce((a, b) => (b.y < a.y ? b : a));
      return [{ peer, at, tag: { x: top.x, y: top.y - top.r } }];
    }),
  );
  /** Others dragging a split that has no record yet: matched to a lane by where it is. */
  const remoteNew = createMemo(() => {
    const m = new Map<string, PeerPresence>();
    for (const x of st.peerList()) {
      const d = x.state?.drag;
      if (!d || st.records[d.id] || x.state?.scene !== p.scene) continue;
      const at = worldToMap(d.pos);
      for (const l of p.art.model.lanes) if (project(l.line, at).dist < 4) m.set(l.key, x);
    }
    return m;
  });

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
    capture(svg, e.pointerId);
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

  /** The objective marker under a point (view units), nearest first. Camps, rifts, mid boss too. */
  const objectiveAt = (pt: Pt) => {
    let best: { m: Marker; d: number } | undefined;
    for (const m of p.art.model.markers) {
      if (!p.showHidden && p.objectives().get(m.key)?.status === "Hidden") continue;
      const at = mapToView(m.at, p.vp);
      const d = Math.hypot(at.x - pt.x, at.y - pt.y);
      // About the drawn icon (the HUD images have wide transparent margins), so lanes and
      // empty map between icons stay clickable.
      const reach = Math.max(m.kind === "camp" ? 12 : 16, m.px * HUD_PX * 0.25) * Math.max(p.k, 0.5);
      if (d <= reach && (!best || d < best.d)) best = { m, d };
    }
    return best?.m;
  };

  const clearObjects = () => {
    if (p.objSelection().size) p.setObjSelection(new Set());
  };
  /** A click on an objective: the whole group if it's in your selection, else just it. */
  const clickObjective = (m: Marker) => {
    const scene = p.scene;
    if (!scene) return;
    const sel = p.objSelection();
    if (sel.has(m.key)) {
      const group = p.art.model.markers.filter((x) => sel.has(x.key));
      const ops = groupToggleOps(m, group, p.art.model.markers, p.objectives(), scene, newRecordId);
      if (ops.length) st.edit(ops); // one transaction: one undo puts the whole group back
      return;
    }
    clearObjects();
    toggleObjective(m);
  };
  const toggleObjective = (m: Marker) => {
    const scene = p.scene;
    if (!scene) return;
    const ops = toggleOps(m, p.art.model.markers, p.objectives(), scene, newRecordId);
    if (ops.length) st.edit(ops);
  };

  /** The lane under a point (view units) and the `t` there, if it's close to the line. */
  const laneAt = (pt: Pt, reach: number) => {
    const m = viewToMap(pt, p.vp);
    let best: { key: string; t: number; dist: number } | undefined;
    for (const l of p.art.model.lanes) {
      const q = project(l.line, m);
      if (q.dist <= reach && (!best || q.dist < best.dist)) best = { key: l.key, t: q.t, dist: q.dist };
    }
    return best;
  };

  /** Slide a lane's split: a live preview through presence, then one op on release. */
  const dragWave = (e: PointerEvent, key: string, t0: number) => {
    const lane = p.art.model.lanes.find((l) => l.key === key);
    const scene = p.scene;
    if (!lane || !scene) return;
    e.preventDefault();
    e.stopPropagation();
    const existing = p.waves().get(key);
    const id = existing?.id ?? newRecordId();
    const svg = p.svg()!;
    const start = svgPoint(svg, e);
    let travelled = 0;
    const show = (t: number) => {
      p.setWaveDrag({ key, t, id });
      st.presence({ drag: { id, pos: clampToMap(mapToWorld(pointAt(lane.line, t))) }, focus: id });
    };
    show(t0);
    track(
      e,
      (pt) => {
        travelled = Math.max(travelled, Math.hypot(pt.x - start.x, pt.y - start.y));
        show(project(lane.line, viewToMap(pt, p.vp)).t);
      },
      (_, ok) => {
        const d = p.waveDrag();
        p.setWaveDrag(undefined);
        st.presence({ drag: null, focus: null });
        if (!ok || !d) return;
        // A click (no drag) on the gap over an objective, like the mid boss on the mid lane's
        // centre, is a click on the objective.
        const m = travelled < 4 ? objectiveAt(start) : undefined;
        if (m) return clickObjective(m);
        clearObjects();
        if (existing) {
          if (existing.t !== d.t) st.edit([{ Set: { id, value: { WavePos: d.t } } }]);
        } else st.edit([{ Create: { id, record: { Wave: { scene, lane: key, t: d.t } } } }]);
      },
    );
  };

  /** Pan by dragging: middle or right button anywhere, Space+drag, or a viewer's Look drag. */
  const pan = (e: PointerEvent) => {
    const svg = p.svg()!;
    e.preventDefault();
    e.stopPropagation(); // a pan never also drags the hero under the pointer
    const perPx = 1000 / svg.getBoundingClientRect().width;
    let last = { x: e.clientX, y: e.clientY };
    track(
      e,
      (_, ev) => {
        p.onPan((ev.clientX - last.x) * perPx, (ev.clientY - last.y) * perPx);
        last = { x: ev.clientX, y: ev.clientY };
      },
      () => {},
    );
  };

  /** Move on empty map: drag a rectangle to select heroes (Shift adds); a click clears. */
  const marquee = (e: PointerEvent, start: Pt) => {
    e.preventDefault();
    const add = e.shiftKey;
    const base = add ? new Set(p.selection()) : new Set<RecordId>();
    track(
      e,
      (pt) => setBox({ a: start, b: pt }),
      (pt, ok) => {
        const b = box();
        setBox(undefined);
        if (!ok) return;
        if (!b || Math.hypot(pt.x - start.x, pt.y - start.y) < 4) {
          if (!add) {
            p.setSelection(new Set());
            p.setObjSelection(new Set());
          }
          return;
        }
        const rect = { x0: Math.min(b.a.x, b.b.x), x1: Math.max(b.a.x, b.b.x), y0: Math.min(b.a.y, b.b.y), y1: Math.max(b.a.y, b.b.y) };
        // Heroes inside win; with none inside, every objective inside is picked up.
        const picked = marqueePick(
          rect,
          st.playersIn(p.scene).flatMap((pl) => (pl.state.placed ? [{ id: pl.id, at: view(pl.state.pos) }] : [])),
          p.art.model.markers
            .filter((m) => p.showHidden || p.objectives().get(m.key)?.status !== "Hidden")
            .map((m) => ({ key: m.key, at: mapToView(m.at, p.vp) })),
        );
        if (picked.heroes.length) {
          p.setObjSelection(new Set());
          p.setSelection(new Set([...base, ...picked.heroes]));
        } else if (picked.objectives.length) {
          p.setSelection(new Set());
          p.setObjSelection(new Set([...(add ? p.objSelection() : []), ...picked.objectives]));
        } else if (!add) {
          p.setSelection(new Set());
          p.setObjSelection(new Set());
        }
      },
    );
  };

  const down = (e: PointerEvent) => {
    if (!p.scene) return;
    const svg = p.svg();
    if (!svg) return;
    // A press anywhere but on a comment closes the open one.
    const onComment = (e.target as Element).closest?.("[data-callout]")?.getAttribute("data-callout");
    if (!onComment) p.setOpenComment(undefined);
    if (e.button === 1 || e.button === 2 || (e.button === 0 && p.spaceHeld())) {
      pan(e);
      return;
    }
    if (e.button !== 0) return;
    const start = svgPoint(svg, e);
    const tool = p.tool;
    if (tool === "laser") {
      e.preventDefault();
      pushLaser(start);
      track(e, (pt) => pushLaser(pt), () => {});
      return;
    }
    if (tool === "move") {
      if (!editor()) {
        if (onComment) return; // the comment handles its own click
        pan(e); // Look: dragging the map pans
        return;
      }
      // Heroes, callouts and lane splits handle their own presses (Solid delegates those
      // handlers to the document, so this native listener on the map sees the press first).
      if ((e.target as Element).closest?.(".tok, .co, .wave-hit")) return;
      const m = objectiveAt(start);
      if (m) {
        e.preventDefault();
        track(
          e,
          () => {},
          (pt, ok) => {
            if (ok && Math.hypot(pt.x - start.x, pt.y - start.y) < 8) clickObjective(m);
          },
        );
        return;
      }
      // A click on a lane's zipline jumps its split there, and a drag slides it.
      const lane = laneAt(start, 9 * Math.max(p.k, 0.6));
      if (lane) {
        dragWave(e, lane.key, lane.t);
        return;
      }
      marquee(e, start);
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
    p.setOpenComment(undefined); // collapses after editing (unless all are open)
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
    if (p.tool !== "move" || e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    if (!editor()) {
      // Look: a click opens or closes a comment; nothing moves.
      track(e, () => {}, (_, ok) => ok && p.setOpenComment(p.isOpen(c.id) ? undefined : c.id));
      return;
    }
    const svg = p.svg()!;
    const start = svgPoint(svg, e);
    const grab = view(c.r.pos);
    let moved = false;
    track(
      e,
      (pt) => {
        if (!moved && Math.hypot(pt.x - start.x, pt.y - start.y) < 4) return;
        moved = true;
        const pos = world({ x: grab.x + pt.x - start.x, y: grab.y + pt.y - start.y });
        setDragCallout({ id: c.id, pos });
        st.presence({ drag: { id: c.id, pos }, focus: c.id });
      },
      (_, ok) => {
        const d = dragCallout();
        setDragCallout(undefined);
        // Focus goes back to whatever comment this person has open (followers mirror it).
        st.presence({ drag: null, focus: p.openComment() ?? null });
        if (ok && moved && d) st.edit([{ Set: { id: c.id, value: { CalloutPos: d.pos } } }]);
        if (ok && !moved) {
          // A bubble opens on a click; an open comment edits on a double click.
          const now = performance.now();
          if (!p.isOpen(c.id)) {
            lastTap = undefined; // the opening click isn't the first half of a double click
            p.setOpenComment(c.id);
          } else if (lastTap?.id === c.id && now - lastTap.t < 450) {
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
            const open = () => p.isOpen(c.id) || hidden();
            const tags = () => (
              <For each={others()}>
                {(o, i) => (
                  <NameTag
                    at={{ x: (open() ? bx() - 30 : pos().x - 14 * p.k), y: (open() ? by() + 10 : pos().y - 40 * p.k) - i() * 32 * p.k }}
                    name={o.state!.name}
                    color={o.state!.color}
                    what={o.state!.drag?.id === c.id ? "moving" : undefined}
                    k={p.k}
                  />
                )}
              </For>
            );
            return (
              <Show
                when={open()}
                fallback={
                  <g
                    class={cx("co", "bubble", erasing().has(c.id) && "erasing", others().length > 0 && "touched")}
                    data-erase={c.id}
                    data-callout={c.id}
                    data-open="false"
                    onPointerDown={(e) => calloutDown(c, e)}
                  >
                    <g transform={`translate(${pos().x} ${pos().y}) scale(${p.k})`}>
                      <path class="bubble-body" d={BUBBLE} />
                      <path class="bubble-dots" d="M-7 -19h0.01M0 -19h0.01M7 -19h0.01" />
                      <g class="preview" data-testid="comment-preview">
                        <rect x="20" y="-34" width={textWidth(c.r.text, 15)} height="28" rx="5" />
                        <text x="31" y="-20" style={{ "font-size": "15px" }}>
                          {c.r.text}
                        </text>
                      </g>
                    </g>
                    {tags()}
                  </g>
                }
              >
              <g
                class={cx("co", erasing().has(c.id) && "erasing", others().length > 0 && "touched")}
                data-erase={c.id}
                data-callout={c.id}
                data-open="true"
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
                  {(o) => <rect class="p-outline" x={bx() - 4} y={by() - 4} width={w() + 8} height="45" rx="9" stroke={colorOf(o.state!.color)} />}
                </For>
                {tags()}
              </g>
              </Show>
            );
          }}
        </For>
        <Show when={editing()}>
          {(ed) => {
            const pos = () => view(ed().pos);
            const x = () => Math.min(pos().x + 16, 1000 - 300);
            return (
              <g class="co editing" data-callout={ed().id ?? "new"}>
                <circle class="pin" cx={pos().x} cy={pos().y} r="6" />
                <foreignObject x={x()} y={pos().y - 60} width="300" height="44">
                  <input
                    class="callout-input"
                    data-testid="comment-input"
                    aria-label="Comment"
                    maxLength={MAX_CALLOUT}
                    value={ed().text}
                    placeholder="Comment"
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
      <Show when={box()}>
        {(b) => (
          <rect
            class="marquee"
            data-testid="marquee"
            x={Math.min(b().a.x, b().b.x)}
            y={Math.min(b().a.y, b().b.y)}
            width={Math.abs(b().b.x - b().a.x)}
            height={Math.abs(b().b.y - b().a.y)}
          />
        )}
      </Show>
      <Tokens state={st} art={p.art} vp={p.vp} scene={p.scene} tool={p.tool} k={p.k} svg={p.svg} selection={p.selection} setSelection={p.setSelection} onPress={clearObjects} />
      <For each={othersPicks()}>
        {(x) => (
          <g class="picks" data-picks={x.peer.state!.name} style={{ "pointer-events": "none" }}>
            <For each={x.at}>{(q) => <circle class="pick-ring" cx={q.x} cy={q.y} r={q.r} stroke={colorOf(x.peer.state!.color)} />}</For>
            <NameTag at={x.tag} name={x.peer.state!.name} color={x.peer.state!.color} what={`${x.at.length} selected`} k={p.k} />
          </g>
        )}
      </For>
      <g class="waves">
        <For each={p.art.model.lanes}>
          {(l) => {
            const at = () => mapToView(pointAt(l.line, p.splitOf(l.key)), p.vp);
            const raised = () => p.waveDrag()?.key === l.key;
            const halves = () => splitAt(l.line, p.splitOf(l.key), LANE_GAP);
            const remote = () => st.peerList().find((x) => x.state?.drag && x.state.drag.id === (p.waves().get(l.key)?.id ?? "") ) ?? remoteNew().get(l.key);
            return (
              <>
                <Show when={raised()}>
                  {/* The lane being dragged, above the heroes and objectives (only for its dragger). */}
                  <g class="lane-raised" data-raised={l.key}>
                    <path d={pathOf(halves().amber.map((q) => mapToView(q, p.vp)))} stroke={laneStroke(l.lane, "amber", p.vp)} />
                    <path d={pathOf(halves().sapphire.map((q) => mapToView(q, p.vp)))} stroke={laneStroke(l.lane, "sapphire", p.vp)} />
                  </g>
                </Show>
                <Show when={editor() && p.tool === "move"}>
                  <circle
                    class={cx("wave-hit", raised() && "active")}
                    data-testid={`wave-gap-${l.key}`}
                    cx={at().x}
                    cy={at().y}
                    r={14 * p.k}
                    onPointerDown={(e) => e.button === 0 && !p.spaceHeld() && dragWave(e, l.key, p.splitOf(l.key))}
                  >
                    <title>Wave</title>
                  </circle>
                </Show>
                <Show when={remote()}>
                  {(x) => <NameTag at={{ x: at().x - 10 * p.k, y: at().y + 18 * p.k }} name={x().state!.name} color={x().state!.color} what="moving the wave" k={p.k} />}
                </Show>
              </>
            );
          }}
        </For>
      </g>
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
