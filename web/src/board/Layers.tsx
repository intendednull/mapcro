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

import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount, untrack } from "solid-js";
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
import { CARD, cardBox } from "./commentLayout";
import type { MatchPreview } from "../match/MatchPanel";
import type { Art } from "../map/pack";
import { type Pt, type Viewpoint, clampShift, clampToBoard, clampToMap, mapToView, mapToWorld, viewToMap, viewToWorld, worldToMap, worldToView } from "../map/transform";
import { newRecordId } from "../wasm/mapcro_wasm.js";
import { cx } from "../ui/cx";
import { LASER_MAX_POINTS, type Timed, arrowHead, fitStroke, laserOpacity, polyline, pruneLaser, shaftEnd } from "./geometry";
import { moveStrokeOps, strokePoints } from "./placed";
import { smoothed } from "./smooth";
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

export function Layers(p: {
  state: BoardState;
  art: Art;
  vp: Viewpoint;
  scene: RecordId | undefined;
  /** The scene whose player rows the tokens use, if not `scene` (Player: the shown scene). */
  tokenScene?: RecordId | undefined;
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
  preview?: (() => MatchPreview | undefined) | undefined;
  /** Comments are drawn at screen size: view units per screen pixel, and the visible part of the map. */
  unitsPerPx: () => number;
  visible: () => { x: number; y: number; w: number };
  setOpenComment: (id: RecordId | undefined) => void;
}) {
  const st = p.state;
  const view = (w: WorldPos) => worldToView(w, p.vp);
  // Ink, arrows, comments and pointers may go in the notes margin round the map.
  const world = (v: Pt) => clampToBoard(viewToWorld(v, p.vp));
  /** World units between two view points (unclamped). */
  const worldDelta = (a: Pt, b: Pt) => {
    const wa = viewToWorld(a, p.vp);
    const wb = viewToWorld(b, p.vp);
    return { x: wb.x - wa.x, y: wb.y - wa.y };
  };
  const editor = () => st.canEdit();

  // Stable rows (one object per record), so a new stroke adds one node and moves nothing else.
  const strokes = createMemo(() => st.rowsIn<Stroke>("Stroke", p.scene));
  const arrows = createMemo(() => st.rowsIn<Arrow>("Arrow", p.scene));
  const callouts = createMemo(() => calloutOrder(st.rowsIn<Callout>("Callout", p.scene)));
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

  const erasableAtPoint = (x: number, y: number) => {
    for (const el of document.elementsFromPoint(x, y)) {
      const id = (el as HTMLElement).closest?.("[data-erase]")?.getAttribute("data-erase");
      if (id) return id;
    }
    return undefined;
  };
  const erasableAt = (ev: PointerEvent) => erasableAtPoint(ev.clientX, ev.clientY);

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
  const pan = (e: PointerEvent, onClick?: (at: Pt) => void) => {
    const svg = p.svg()!;
    e.preventDefault();
    e.stopPropagation(); // a pan never also drags the hero under the pointer
    const perPx = svg.viewBox.baseVal.width / svg.getBoundingClientRect().width;
    const at = svgPoint(svg, e);
    const first = { x: e.clientX, y: e.clientY };
    let last = first;
    let far = 0;
    track(
      e,
      (_, ev) => {
        far = Math.max(far, Math.hypot(ev.clientX - first.x, ev.clientY - first.y));
        p.onPan((ev.clientX - last.x) * perPx, (ev.clientY - last.y) * perPx);
        last = { x: ev.clientX, y: ev.clientY };
      },
      (_, ok) => {
        if (ok && far < 4) onClick?.(at);
      },
    );
  };

  // ---- pings: a middle click, a ring in your colour with your name, through presence ----
  const [pings, setPings] = createSignal<Array<{ key: string; at: WorldPos; color: number; name: string }>>([]);
  const PING_MS = 1600;
  const showPing = (q: { key: string; at: WorldPos; color: number; name: string }) => {
    setPings([...pings().filter((x) => x.key !== q.key), q]);
    setTimeout(() => setPings(pings().filter((x) => x !== q)), PING_MS);
  };
  let pingN = 0;
  let pingClear: ReturnType<typeof setTimeout> | undefined;
  const ping = (at: Pt) => {
    const w = world(at);
    pingN += 1;
    st.presence({ ping: { at: w, n: pingN } });
    showPing({ key: `me:${pingN}`, at: w, color: p.myColor, name: "" });
    clearTimeout(pingClear);
    pingClear = setTimeout(() => st.presence({ ping: null }), PING_MS);
  };
  onCleanup(() => clearTimeout(pingClear));
  const seenPing = new Map<number, number>();
  createEffect(() => {
    for (const x of st.peerList()) {
      const pg = x.state?.ping;
      if (!pg || x.state?.scene !== p.scene || seenPing.get(x.peer) === pg.n) continue;
      seenPing.set(x.peer, pg.n);
      untrack(() => showPing({ key: `${x.peer}:${pg.n}`, at: pg.at, color: x.state!.color, name: x.state!.name }));
    }
  });

  // ---- moving placed things (Move): arrows whole or by one end, strokes whole ----
  const [movingArrow, setMovingArrow] = createSignal<{ id: RecordId; from: WorldPos; to: WorldPos }>();
  const [movingStroke, setMovingStroke] = createSignal<{ id: RecordId; d: { x: number; y: number } }>();
  /** A press that didn't move: what a press on the map there would have done (an objective). */
  const pressThrough = (at: Pt) => {
    const m = objectiveAt(at);
    if (m) clickObjective(m);
  };
  const moveArrow = (e: PointerEvent, a: Rec<Arrow>, end: "From" | "To" | undefined) => {
    e.preventDefault();
    const start = svgPoint(p.svg()!, e);
    const { from: f0, to: t0 } = a.r;
    let moved = false;
    track(
      e,
      (pt) => {
        if (!moved && Math.hypot(pt.x - start.x, pt.y - start.y) < 4) return;
        moved = true;
        const d = worldDelta(start, pt);
        const shift = (q: WorldPos, s: { x: number; y: number }) => ({ x: q.x + s.x, y: q.y + s.y });
        let from = f0;
        let to = t0;
        if (end === "From") from = clampToBoard(shift(f0, d));
        else if (end === "To") to = clampToBoard(shift(t0, d));
        else {
          const s = clampShift([f0, t0], d);
          from = shift(f0, s);
          to = shift(t0, s);
        }
        setMovingArrow({ id: a.id, from, to });
        st.presence({ drag: { id: a.id, pos: end === "To" ? to : from, ...(end ? { end } : {}) }, focus: a.id });
      },
      (pt, ok) => {
        const m = movingArrow();
        setMovingArrow(undefined);
        if (moved) st.presence({ drag: null, focus: null });
        if (ok && moved && m) {
          const ops: Op[] = [];
          if (m.from.x !== f0.x || m.from.y !== f0.y) ops.push({ Set: { id: a.id, value: { ArrowFrom: m.from } } });
          if (m.to.x !== t0.x || m.to.y !== t0.y) ops.push({ Set: { id: a.id, value: { ArrowTo: m.to } } });
          if (ops.length) st.edit(ops);
        } else if (ok && !moved) pressThrough(pt);
      },
    );
  };
  const moveStroke = (e: PointerEvent, s: Rec<Stroke>) => {
    e.preventDefault();
    const start = svgPoint(p.svg()!, e);
    const pts = strokePoints(s.r);
    let moved = false;
    track(
      e,
      (pt) => {
        if (!moved && Math.hypot(pt.x - start.x, pt.y - start.y) < 4) return;
        moved = true;
        const d = clampShift(pts, worldDelta(start, pt));
        setMovingStroke({ id: s.id, d });
        st.presence({ drag: { id: s.id, pos: { x: pts[0]!.x + d.x, y: pts[0]!.y + d.y } }, focus: s.id });
      },
      (pt, ok) => {
        const m = movingStroke();
        setMovingStroke(undefined);
        if (moved) st.presence({ drag: null, focus: null });
        if (ok && moved && m && (m.d.x || m.d.y)) st.edit(moveStrokeOps(s.id, s.r, m.d));
        else if (ok && !moved) pressThrough(pt);
      },
    );
  };
  /** Others moving a placed thing: who, and where its anchor is now (smoothed per record below). */
  const moverOf = (id: RecordId) => st.peerList().find((x) => x.state?.drag?.id === id && x.state.scene === p.scene);

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
    if (e.button === 1) {
      // Middle: a click pings (anyone, viewers too), a drag pans.
      pan(e, ping);
      return;
    }
    if (e.button === 2 || (e.button === 0 && p.spaceHeld())) {
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
      const target = e.target as Element;
      const arrowId = target.closest?.("[data-arrow]")?.getAttribute("data-arrow");
      const arrow = arrowId ? arrows().find((x) => x.id === arrowId) : undefined;
      if (arrow) {
        const end = target.closest?.("[data-arrow-end]")?.getAttribute("data-arrow-end");
        moveArrow(e, arrow, end === "From" || end === "To" ? end : undefined);
        return;
      }
      const strokeId = target.closest?.("[data-stroke]")?.getAttribute("data-stroke");
      const stroke = strokeId ? strokes().find((x) => x.id === strokeId) : undefined;
      if (stroke) {
        moveStroke(e, stroke);
        return;
      }
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
      // Others see the stroke as it's drawn (through presence, like the laser), then the record.
      const live = () => st.presence({ ink: { color: p.ink, points: fitStroke(drawing() ?? [], MAX_STROKE_POINTS).map(world) } });
      live();
      track(
        e,
        (pt) => {
          setDrawing([...(drawing() ?? []), pt]);
          live();
        },
        (_, ok) => {
          const pts = drawing() ?? [];
          setDrawing(undefined);
          st.presence({ ink: null });
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
    // Hover + E deletes the placed thing under the pointer, whatever the tool (operator,
    // 2026-11-07). Ahead of the toolbar's E (Erase), which still applies over empty map.
    let hover: { x: number; y: number } | undefined;
    const track = (e: PointerEvent) => (hover = { x: e.clientX, y: e.clientY });
    const untrackHover = () => (hover = undefined);
    const del = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== "e" || e.ctrlKey || e.metaKey || e.altKey || e.repeat || !hover || !editor()) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      const id = erasableAtPoint(hover.x, hover.y);
      if (!id) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      st.edit([{ Delete: { id } }]);
    };
    window.addEventListener("keydown", del, true);
    svg.addEventListener("pointermove", track);
    svg.addEventListener("pointerleave", untrackHover);
    onCleanup(() => {
      window.removeEventListener("keydown", del, true);
      svg.removeEventListener("pointermove", track);
      svg.removeEventListener("pointerleave", untrackHover);
    });
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
  const remoteInks = createMemo(() => st.peerList().filter((x) => (x.state?.ink?.points.length ?? 0) > 0 && x.state?.scene === p.scene));

  return (
    <>
      <g class="arrows">
        <For each={arrows()}>
          {(a) => {
            const mover = () => moverOf(a.id);
            const anchor = smoothed(() => mover()?.state?.drag?.pos);
            const ends = () => {
              const mine = movingArrow();
              if (mine?.id === a.id) return mine;
              const end = mover()?.state?.drag?.end;
              const q = anchor();
              if (!q) return a.r;
              if (end === "From") return { from: q, to: a.r.to };
              if (end === "To") return { from: a.r.from, to: q };
              return { from: q, to: { x: a.r.to.x + q.x - a.r.from.x, y: a.r.to.y + q.y - a.r.from.y } };
            };
            const f = () => view(ends().from);
            const t = () => view(ends().to);
            return (
              <g class={cx("arrow", erasing().has(a.id) && "erasing", (movingArrow()?.id === a.id || !!mover()) && "moving")} data-erase={a.id} data-arrow={a.id}>
                <path class="hit" d={`M${f().x} ${f().y} L${t().x} ${t().y}`} />
                <path class={cx("arw", arrowClass(a.r.team))} d={polyline([f(), shaftEnd(f(), t(), 10)])} />
                <polygon class={cx("head", arrowClass(a.r.team))} points={arrowHead(f(), t(), 22)} />
                <Show when={editor() && p.tool === "move"}>
                  <circle class="arrow-end" data-arrow-end="From" cx={f().x} cy={f().y} r={9 * p.k} />
                  <circle class="arrow-end" data-arrow-end="To" cx={t().x} cy={t().y} r={9 * p.k} />
                </Show>
                <Show when={mover()}>
                  {(o) => <NameTag at={{ x: (f().x + t().x) / 2, y: (f().y + t().y) / 2 }} name={o().state!.name} color={o().state!.color} what="moving" k={p.k} />}
                </Show>
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
            const mover = () => moverOf(s.id);
            const anchor = smoothed(() => mover()?.state?.drag?.pos);
            const shift = () => {
              const mine = movingStroke();
              if (mine?.id === s.id) return mine.d;
              const q = anchor();
              const p0 = strokePoints(s.r)[0];
              return q && p0 ? { x: q.x - p0.x, y: q.y - p0.y } : { x: 0, y: 0 };
            };
            const pts = () => strokePoints(s.r).map((q) => view({ x: q.x + shift().x, y: q.y + shift().y }));
            const d = () => polyline(pts());
            return (
              <g data-erase={s.id} data-stroke={s.id} class={cx(erasing().has(s.id) && "erasing", (movingStroke()?.id === s.id || !!mover()) && "moving")}>
                <path class="hit" d={d()} />
                <path class={cx("ink", erasing().has(s.id) && "erasing")} d={d()} stroke={colorOf(s.r.color)} style={{ "stroke-width": `${s.r.width / 10}` }} />
                <Show when={mover()}>{(o) => <NameTag at={pts()[0]!} name={o().state!.name} color={o().state!.color} what="moving" k={p.k} />}</Show>
              </g>
            );
          }}
        </For>
        <Show when={drawing()}>{(pts) => <path class="ink preview" d={polyline(pts())} stroke={colorOf(p.ink)} style={{ "stroke-width": `${INK_WIDTH / 10}` }} />}</Show>
        <For each={remoteInks()}>
          {(x) => {
            const pts = () => (x.state?.ink?.points ?? []).map(view);
            return (
              <g class="live-ink" data-live-ink={x.state!.name}>
                <path class="ink preview" d={polyline(pts())} stroke={colorOf(x.state?.ink?.color ?? 0)} style={{ "stroke-width": `${INK_WIDTH / 10}` }} />
                <Show when={pts().at(-1)}>{(q) => <NameTag at={q()} name={x.state!.name} color={x.state!.color} what="drawing" k={p.k} />}</Show>
              </g>
            );
          }}
        </For>
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
      <Tokens state={st} art={p.art} vp={p.vp} scene={p.tokenScene ?? p.scene} tool={p.tool} k={p.k} svg={p.svg} selection={p.selection} setSelection={p.setSelection} onPress={clearObjects} preview={p.preview} />
      <For each={othersPicks()}>
        {(x) => (
          <g class="picks" data-picks={x.peer.state!.name} style={{ "pointer-events": "none" }}>
            <For each={x.at}>{(q) => <circle class="pick-ring" cx={q.x} cy={q.y} r={q.r} stroke={colorOf(x.peer.state!.color)} />}</For>
            <NameTag at={x.tag} name={x.peer.state!.name} color={x.peer.state!.color} what={`${x.at.length} selected`} k={p.k} />
          </g>
        )}
      </For>
      <g class="callouts">
        <For each={callouts()}>
          {(c) => {
            const others = () => touching().get(c.id) ?? [];
            const remote = smoothed(() => others().find((o) => o.state?.drag?.id === c.id)?.state?.drag?.pos);
            const pos = () => view(dragCallout()?.id === c.id ? dragCallout()!.pos : (remote() ?? c.r.pos));
            const hidden = () => editing()?.id === c.id;
            if (p.compactCallouts)
              return (
                <g class="co-pin" data-callout={c.id} transform={`translate(${pos().x} ${pos().y}) scale(${p.k})`}>
                  <circle r="16" />
                  <text>{callouts().findIndex((x) => x.id === c.id) + 1}</text>
                </g>
              );
            const sc = () => p.unitsPerPx();
            const box = () => cardBox(c.r.text, pos(), sc(), p.visible());
            const open = () => p.isOpen(c.id) || hidden();
            const card = (cls: string) => (
              <g class={cls}>
                <rect class="card-bg" x={box().x} y={box().y} width={box().w} height={box().h} rx={5 * sc()} />
                <For each={box().lines}>
                  {(line, i) => (
                    <text x={box().x + CARD.padX * sc()} y={box().y + (CARD.padY + CARD.line * (i() + 0.5)) * sc()} style={{ "font-size": `${CARD.font * sc()}px` }}>
                      {line}
                    </text>
                  )}
                </For>
              </g>
            );
            const tags = () => (
              <For each={others()}>
                {(o, i) => (
                  <NameTag
                    at={{ x: (open() ? box().x : pos().x) - 30 * p.k, y: (open() ? box().y + 14 * p.k : pos().y - 40 * p.k) - i() * 32 * p.k }}
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
                    <g transform={`translate(${pos().x} ${pos().y}) scale(${sc() * 0.8})`}>
                      <path class="bubble-body" d={BUBBLE} />
                      <path class="bubble-dots" d="M-7 -19h0.01M0 -19h0.01M7 -19h0.01" />
                    </g>
                    <g class="preview" data-testid="comment-preview">
                      {card("preview-card")}
                    </g>
                    {tags()}
                  </g>
                }
              >
                <g
                  class={cx("co", "open", erasing().has(c.id) && "erasing", others().length > 0 && "touched")}
                  data-erase={c.id}
                  data-callout={c.id}
                  data-open="true"
                  style={{ opacity: hidden() ? 0.25 : undefined }}
                  onPointerDown={(e) => calloutDown(c, e)}
                >
                  <path class="leader" d={`M${pos().x} ${pos().y} L${Math.min(Math.max(pos().x, box().x), box().x + box().w)} ${Math.min(Math.max(pos().y, box().y), box().y + box().h)}`} style={{ "stroke-width": `${1.5 * sc()}` }} />
                  <circle class="pin" cx={pos().x} cy={pos().y} r={5 * sc()} style={{ "stroke-width": `${2 * sc()}` }} />
                  {card("open-card")}
                  <For each={others()}>
                    {(o) => <rect class="p-outline" x={box().x - 3 * sc()} y={box().y - 3 * sc()} width={box().w + 6 * sc()} height={box().h + 6 * sc()} rx={7 * sc()} stroke={colorOf(o.state!.color)} />}
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
            const sc = () => p.unitsPerPx();
            // Placed like a card with room for a full-width line.
            const box = () => cardBox("x".repeat(26), pos(), sc(), p.visible());
            return (
              <g class="co editing" data-callout={ed().id ?? "new"}>
                <circle class="pin" cx={pos().x} cy={pos().y} r={5 * sc()} style={{ "stroke-width": `${2 * sc()}` }} />
                <g transform={`translate(${box().x} ${box().y}) scale(${sc()})`}>
                  <foreignObject x="0" y="-4" width={CARD.maxW} height="32">
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
              </g>
            );
          }}
        </Show>
      </g>
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
                    onPointerDown={(e) => e.button === 0 && !p.spaceHeld() && dragWave(e, l.key, Math.round(p.splitOf(l.key)))}
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
      <g class="pings">
        <For each={pings()}>
          {(q) => {
            const at = () => view(q.at);
            return (
              <g class="ping" data-ping={q.name || "me"} style={{ "--c": colorOf(q.color) }}>
                <circle class="ping-ring" cx={at().x} cy={at().y} r={26 * p.k} />
                <circle class="ping-ring late" cx={at().x} cy={at().y} r={26 * p.k} />
                <circle class="ping-dot" cx={at().x} cy={at().y} r={5 * p.k} />
                <Show when={q.name}>
                  <NameTag at={at()} name={q.name} color={q.color} k={p.k} />
                </Show>
              </g>
            );
          }}
        </For>
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
export function calloutOrder<T extends { id: RecordId }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => (a.id < b.id ? -1 : 1));
}
