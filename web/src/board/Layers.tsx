// The board's own layers over the minimap, and every gesture the tools make on it
// (spec §4: the map is the interface, the picker only chooses the gesture):
//
//   Select   drag heroes and callouts, click objectives to cycle them, double-click a callout to edit
//   Draw     freehand ink in the palette colour            → one Stroke
//   Arrow    drag out a rotation arrow (team from the hero it starts on) → one Arrow
//   Callout  click to place a label, typed in place        → one Callout
//   Laser    a trail others see, fading; presence only, viewers too
//   Erase    click or scrub over ink, arrows and callouts  → one transaction of deletes
//
// A right click (no drag) on a placed comment, arrow or stroke opens its menu (editors): a
// comment's side (feedback #59) and a colour for any of the three (feedback #60). On touch, in
// Select, a long press on it does (TD-107, longPress.ts).
//
// Layer order (design/parity/README.md, layer 10): arrows, ink and callouts, drag ghosts, hero
// tokens, then lasers, cursors and name tags.

import { For, Index, Show, createEffect, createMemo, createSignal, createUniqueId, onCleanup, onMount, untrack, type Signal } from "solid-js";
import { capture } from "../ui/capture";
import { touchGestures } from "./touchGestures";
import { longPress, reachPoints, swallowLiftClick } from "./longPress";
import { PALETTE, colorOf, inkOn } from "../core/device";
import type { Arrow } from "../gen/Arrow";
import type { Callout } from "../gen/Callout";
import type { ObjectiveStatus } from "../gen/ObjectiveStatus";
import type { Op } from "../gen/Op";
import type { PeerPresence } from "../gen/PeerPresence";
import type { RecordId } from "../gen/RecordId";
import type { SceneState } from "../gen/SceneState";
import type { Stroke } from "../gen/Stroke";
import type { WorldPos } from "../gen/WorldPos";
import { HUD_PX, type Marker, isFurniture, laneStroke, teamName, teamShort, washFor } from "../map/model";
import { pathOf, pointAt, project, splitAt, splitEdges } from "../map/lanes";
import { LANE_GAP } from "../map/MapView";
import { groupToggleOps, marqueePick, toggleOps } from "./objectives";
import { CARD, SIDES, bubble, cardBox } from "./commentLayout";
import { ContextMenu, type MenuItem } from "../ui/ContextMenu";
import type { Art } from "../map/pack";
import { type Pt, type Viewpoint, clampShift, clampToBoard, clampToDisc, clampToMap, mapToView, mapToWorld, viewToMap, viewToWorld, worldToMap, worldToView } from "../map/transform";
import { slotKey } from "../match/save";
import type { Timeline } from "../match/timeline";
import { captured } from "../mapstate/build";
import { isHealthKind } from "../mapstate/codec";
import {
  liveObjUpsert,
  liveWaveUpsertOps,
  pauseClockOps,
  prepareLivePauseEdit,
  preparePausedSceneState,
  seedObjHealthMap,
} from "../mapstate/paused";
import { liveWaveId, pauseClock } from "../player/live";
import {
  type DoorIdentity,
  type SceneDoorContext,
  type SceneObjHealthContext,
  doorIdentity,
  linkSecondDoorOps,
  moveDoorOps,
  placeDoorwayOps,
  removeDoorwayOps,
  removeDoorwaysOps,
  resolveDoorIndex,
  setObjectiveHealthOps,
  toggleDoorSightOps,
  unlinkDoorOps,
} from "../mapstate/edit";
import { HEALTH_NAME } from "../player/Camps";
import { DOORMAN_HERO_ID, DOOR_PAIR_MIN_DIST, DOOR_R, type DragDoor, type PlacingDoor } from "../player/Doors";
import { newRecordId } from "../wasm/mapcro_wasm.js";
import { cx } from "../ui/cx";
import { LASER_MAX_POINTS, type Timed, addLaser, arrowHead, fitStroke, laserAlpha, laserClip, laserRuns, laserStarts, polyline, pruneLaser, shaftEnd, stampLaser } from "./geometry";
import { PRESENCE_MS } from "../core/session";
import { type Placed, liveInk, moveStrokeOps, recolourOps, sideOps, strokePoints } from "./placed";
import { smoothed } from "./smooth";
import type { BoardState } from "./state";
import { type Tool, TOOLS } from "./tools";
import { NameTag, type TokenFrame, Tokens, svgPoint } from "./Tokens";
import { hoverHandle, hoveredHandle, registerHover } from "../map/HoverLabel";
import { Cursors } from "./Presence";
import { LIMITS } from "../gen/limits";

export const INK_WIDTH = 60; // tenths: 6 map units, the design's ink
const MAX_STROKE_POINTS = LIMITS.max_stroke_points;
const MAX_CALLOUT = LIMITS.max_callout;

type Rec<T> = { id: RecordId; r: T };

/** A comment's side as an attribute: none for Above, so such a comment's DOM is as before sides. */
const sided = (side: Callout["side"]) => (side && side !== "Above" ? side : undefined);

export interface DragObjHealth {
  key: string;
  pct: number;
  stage?: 1 | 2;
}

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
  /** Effective marker status (`ObjectiveState ?? baseline detail`), for first-click accuracy (plan §4). */
  markerStatus?: (key: string) => ObjectiveStatus | undefined;
  /** Lane zipline edges per lane key, if captured (`has("lanes")`), for the raised dragged lane (Q7). */
  laneEdges?: (lane: string) => { amber: number; sapphire: number } | undefined;
  /** Zoom scale (view width / 1000): tokens, tags and cursors keep their screen size. */
  k: number;
  /** Select tool on empty map: pan by this much (view units). `fromPinch` is true for 2-finger pinch drift. */
  onPan: (dx: number, dy: number, fromPinch?: boolean) => void;
  /** Wheel: zoom about a point (view units); factor > 1 zooms out. */
  onZoom: (at: Pt, factor: number) => void;
  /** Phone: callouts as numbered pins, their text listed under the map. */
  compactCallouts?: boolean;
  /** Selected heroes (Select): a drag on any of them moves them all. */
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
  /** Objectives selected as a group (Select, editors), by key. */
  objSelection: () => Set<string>;
  setObjSelection: (s: Set<string>) => void;
  /** Comments: whether one shows as its full card, and this person's open one. */
  isOpen: (id: RecordId) => boolean;
  openComment: () => RecordId | undefined;
  /** What the hero tokens draw: the frame (Player's or the scene's) and the viewer's choices. */
  frame: TokenFrame;
  /** Comments are drawn at screen size: view units per screen pixel, and the visible part of the map. */
  unitsPerPx: () => number;
  visible: () => { x: number; y: number; w: number };
  setOpenComment: (id: RecordId | undefined) => void;
  /** Hands the board a ping at a world spot, the same as a middle click there (hero focus). */
  editing?: boolean;
  bindPing?: (ping: (at: WorldPos) => void) => void;
  /** A hero just focused ("Amber-0"), its token flashes; `n` restarts the flash. */
  focused?: () => { slot: string; n: number } | undefined;
  /** Player: a hero token's single click opens its panel (player/HeroCard.tsx). */
  onOpenHero?: (team: string, slot: number, token?: Element) => void;
  /** Currently camera-tracked hero slot key ("amber-0"). */
  trackedHero?: () => string | undefined;
  /** Double-click / double-tap on a hero token toggles camera tracking. */
  onTrackHero?: (slot: string) => void;
  /** Player: whether a hero's HeroCard is already open. */
  isCardOpen?: (slot: string) => boolean;
  /** Player: close a hero's HeroCard. */
  onCloseCard?: (slot: string) => void;
  /** Scenes: notify Board while locally dragging hero token(s) and when dropped. */
  onDragHero?: (dragging: Set<string> | undefined, dropped?: Set<string>) => void;
  /** A scene: a right click (no drag) on a hero's token opens its menu there (feedback #53). */
  onHeroMenu?: (player: RecordId, at: { x: number; y: number }, fromToken?: boolean) => void;
  /** Manual Doorman doorway placement state (two-step placement & link-second-door preview). */
  placingDoor?: () => PlacingDoor | undefined;
  setPlacingDoor?: (next: PlacingDoor | undefined) => void;
  /** Live local door drag preview (Amendment #2: local preview + atomic commit on drop). */
  dragDoor?: () => DragDoor | undefined;
  setDragDoor?: (next: DragDoor | undefined) => void;
  /** Door indices currently being scrubbed by the Erase tool. */
  erasingDoors?: () => Set<number>;
  setErasingDoors?: (next: Set<number>) => void;
  /** Live local objective health vertical scrub preview (objective-health-edit.md §3.2). */
  dragObjHealth?: () => DragObjHealth | undefined;
  setDragObjHealth?: (next: DragObjHealth | undefined) => void;
  /** Called after committing an objective health edit so the board auto-enables `showHealth`. */
  onEditObjHealth?: () => void;
  /** Paused Player context for deterministic live-scene upserts and frame seeding (spec #61). */
  pauseCtx?: {
    board: string;
    matchId: () => number | undefined;
    tl: () => Timeline | undefined;
    t: () => number;
  };
}) {
  const st = p.state;
  const canEditEntities = () => !p.frame.player() || !!p.frame.pausedEdit?.();
  const view = (w: WorldPos) => worldToView(w, p.vp);
  // Ink, arrows, comments and pointers may go in the notes margin round the map.
  const world = (v: Pt) => clampToBoard(viewToWorld(v, p.vp));
  /** World units between two view points (unclamped). */
  const worldDelta = (a: Pt, b: Pt) => {
    const wa = viewToWorld(a, p.vp);
    const wb = viewToWorld(b, p.vp);
    return { x: wb.x - wa.x, y: wb.y - wa.y };
  };
  const editor = () => st.canEdit() && p.editing !== false;

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
  const [editing, setEditing] = createSignal<{ id: RecordId | undefined; pos: WorldPos; text: string; scene?: RecordId }>();
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
    const myClock = p.frame.player() ? p.frame.pauseClock?.() : undefined;
    for (const x of st.peerList()) {
      const d = x.state?.drag;
      const rec = d ? st.records[d.id] : undefined;
      if (!d || (rec && !rec.deleted) || x.state?.scene !== p.scene) continue;
      if (p.frame.player()) {
        const pb = x.state?.playback;
        if (myClock === undefined || !pb || pb.playing || pauseClock(pb.t) !== myClock) continue;
      }
      const at = worldToMap(d.pos);
      for (const l of p.art.model.lanes) if (project(l.line, at).dist < 4) m.set(l.key, x);
    }
    return m;
  });

  // ---- laser: a local trail of timed points, pruned on a ticker and shared as presence ----
  // Each press-to-release is its own gesture: a new press starts a fresh trail, never joined to
  // the one still fading (operator bug, 2026-11-08). Peers get the cuts as `laser_starts`.
  let laserTick: ReturnType<typeof setInterval> | undefined;
  let gesture = 0;
  const pushLaser = (pt: Pt, fresh = false) => {
    const now = performance.now();
    if (fresh) gesture++;
    setLaser(addLaser(laser(), pt, now, gesture));
    st.presence({ laser: laser().map((q) => world(q.p)), laser_starts: laserStarts(laser()), laser_color: p.ink });
    if (!laserTick)
      laserTick = setInterval(() => {
        const next = pruneLaser(laser(), performance.now());
        if (next.length !== laser().length) {
          setLaser(next);
          st.presence({ laser: next.map((q) => world(q.p)), laser_starts: laserStarts(next) });
        }
        if (next.length === 0) {
          clearInterval(laserTick);
          laserTick = undefined;
        }
      }, 50);
  };
  onCleanup(() => clearInterval(laserTick));

  // ---- one pointer gesture on the map, captured until release ----
  const track = (e: PointerEvent, move: (pt: Pt, ev: PointerEvent) => void, up: (pt: Pt, ok: boolean, ev: PointerEvent) => void) => {
    const svg = p.svg();
    if (!svg) return;
    capture(svg, e.pointerId);
    const onMove = (ev: PointerEvent) => ev.pointerId === e.pointerId && move(svgPoint(svg, ev), ev);
    const onUp = (ev: PointerEvent) => {
      if (ev.pointerId !== e.pointerId) return;
      svg.removeEventListener("pointermove", onMove);
      svg.removeEventListener("pointerup", onUp);
      svg.removeEventListener("pointercancel", onUp);
      up(svgPoint(svg, ev), ev.type === "pointerup", ev);
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
  const eraseTargetAtPoint = (x: number, y: number): { kind: "record"; id: RecordId } | { kind: "door"; index: number } | undefined => {
    for (const el of document.elementsFromPoint(x, y)) {
      const id = (el as HTMLElement).closest?.("[data-erase]")?.getAttribute("data-erase");
      if (id) return { kind: "record", id };
      if (canEditEntities()) {
        const doorRaw = (el as HTMLElement).closest?.("[data-erase-door]")?.getAttribute("data-erase-door");
        if (doorRaw != null) {
          const index = Number(doorRaw);
          if (Number.isInteger(index)) return { kind: "door", index };
        }
      }
    }
    return undefined;
  };

  // ---- Doorman doorways (Scenes & paused Player): direct manipulation, placement & menus ----
  const sceneDoors = () => (!canEditEntities() ? [] : p.frame.ms().scene().doors());
  const doorCtx = (): SceneDoorContext | undefined => {
    const scene = p.scene;
    if (!scene || !canEditEntities()) return undefined;
    const row = st.rowsIn<SceneState>("SceneState", scene)[0];
    return { scene, state: row ? { id: row.id, more: row.r.more } : undefined, mint: newRecordId };
  };
  const commitDoorEdit = (build: (ctx: SceneDoorContext) => Op[], extraOps: Op[] = []): boolean => {
    const scene = p.scene;
    if (!scene || !canEditEntities()) return false;
    if (p.frame.player()) {
      const clock = p.frame.pauseClock?.();
      const matchId = p.pauseCtx?.matchId();
      if (!p.pauseCtx || clock === undefined || matchId === undefined) return false;
      // Dry-run before clearing another timestamp so a no-op door edit never wipes peer overrides.
      const scRec = st.records[scene];
      const curClock = scRec && !scRec.deleted && "Scene" in scRec.record ? (scRec.record.Scene.clock ?? null) : null;
      const sameClock = curClock === clock;
      const curRow = sameClock ? st.rowsIn<SceneState>("SceneState", scene)[0] : undefined;
      const dryState = curRow ? { id: curRow.id, more: curRow.r.more ?? {} } : undefined;
      const drySeed = dryState && captured(dryState.more).doors ? undefined : p.frame.ms().scene().doors();
      const dryOps = build({ scene, state: dryState, mint: newRecordId, ...(drySeed ? { seed: drySeed } : {}) });
      if (!dryOps.length && !extraOps.length) return false;
      if (!dryOps.length) return st.edit(extraOps);
      prepareLivePauseEdit(st, scene, clock);
      const { state: ss, prefix } = preparePausedSceneState(st, p.pauseCtx.board, matchId, scene);
      const seed = captured(ss.more).doors ? undefined : p.frame.ms().scene().doors();
      const ops = build({ scene, state: ss, mint: newRecordId, ...(seed ? { seed } : {}) });
      if (!ops.length && !extraOps.length) return false;
      const clockOps = ops.length ? pauseClockOps(st.records as never, scene, clock) : [];
      return st.edit([...extraOps, ...clockOps, ...(ops.length ? prefix : []), ...ops]);
    }
    const ctx = doorCtx();
    const ops = ctx ? build(ctx) : [];
    const all = [...extraOps, ...ops];
    return all.length ? st.edit(all) : false;
  };
  const inPlayableDisc = (pt: Pt) => Math.hypot(pt.x - 500, pt.y - 500) <= 498;
  const doorAtEl = (target: Element | null): number | undefined => {
    const raw = target?.closest?.(".pl-door[data-door-id]")?.getAttribute("data-door-id");
    if (raw == null) return undefined;
    const n = Number(raw);
    return Number.isInteger(n) ? n : undefined;
  };
  const doorNearView = (pt: Pt): number | undefined => {
    if (!canEditEntities()) return undefined;
    let best: { id: number; d: number } | undefined;
    const r = Math.max(8, DOOR_R * p.k);
    for (const d of sceneDoors()) {
      const at = view(d.at);
      const dist = Math.hypot(at.x - pt.x, at.y - pt.y);
      if (dist <= r && (!best || dist < best.d)) best = { id: d.id, d: dist };
    }
    return best?.id;
  };
  const doorNearClient = (svg: SVGSVGElement, x: number, y: number): number | undefined => {
    if (!canEditEntities()) return undefined;
    for (const q of reachPoints(x, y)) {
      const el = document.elementFromPoint(q.x, q.y);
      const idx = el && svg.contains(el) ? doorAtEl(el) : undefined;
      if (idx !== undefined) return idx;
    }
    return undefined;
  };
  const moveDoor = (e: PointerEvent, index: number) => {
    const cur = sceneDoors().find((d) => d.id === index);
    if (!cur) return;
    const expect = doorIdentity(cur);
    e.preventDefault();
    const start = svgPoint(p.svg()!, e);
    const grab = view(cur.at);
    const slop = e.pointerType === "touch" ? 6 : 4;
    let moved = false;
    track(
      e,
      (pt) => {
        if (!moved && Math.hypot(pt.x - start.x, pt.y - start.y) < slop) return;
        if (resolveDoorIndex(sceneDoors(), index, expect) === undefined) {
          p.setDragDoor?.(undefined);
          return;
        }
        moved = true;
        const pos = clampToDisc(viewToWorld({ x: grab.x + pt.x - start.x, y: grab.y + pt.y - start.y }, p.vp));
        p.setDragDoor?.({ index, expect, pos });
      },
      (_, ok) => {
        const d = p.dragDoor?.();
        p.setDragDoor?.(undefined);
        if (!ok || !moved || !d) return;
        commitDoorEdit((ctx) => moveDoorOps(ctx, d.index, d.pos, d.expect));
      },
    );
  };

  /** The objective marker under a point (view units), nearest first. Camps, rifts, mid boss too. */
  const objectiveAt = (pt: Pt) => {
    let best: { m: Marker; d: number } | undefined;
    for (const m of p.art.model.markers) {
      // Shops, teleporters and healing pickups are the map's, not a scene's: nothing to toggle.
      if (isFurniture(m.kind)) continue;
      if (!p.showHidden && p.objectives().get(m.key)?.status === "Hidden") continue;
      const at = mapToView(m.at, p.vp);
      const d = Math.hypot(at.x - pt.x, at.y - pt.y);
      // About the drawn icon (the HUD images have wide transparent margins), so lanes and
      // empty map between icons stay clickable.
      // The Patron's icon is mostly its wide arch: its whole drawn icon takes the click.
      const reach = Math.max(m.kind === "camp" ? 12 : 16, m.px * HUD_PX * (m.kind === "t3" ? 0.42 : 0.25)) * Math.max(p.k, 0.5);
      if (d <= reach && (!best || d < best.d)) best = { m, d };
    }
    return best?.m;
  };

  const clearObjects = () => {
    if (p.objSelection().size) p.setObjSelection(new Set());
  };
  const objHealthCtx = (): SceneObjHealthContext | undefined => {
    const scene = p.scene;
    if (!scene || !canEditEntities()) return undefined;
    const row = st.rowsIn<SceneState>("SceneState", scene)[0];
    return {
      scene,
      state: row ? { id: row.id, more: row.r.more } : undefined,
      objectives: p.objectives(),
      markers: p.art.model.markers,
      mint: newRecordId,
      ...(p.markerStatus ? { shownStatus: p.markerStatus } : {}),
    };
  };
  const commitObjHealth = (m: Marker, pct: number, stage?: 1 | 2) => {
    const scene = p.scene;
    if (!scene || !canEditEntities()) return;
    if (p.frame.player()) {
      const clock = p.frame.pauseClock?.();
      const matchId = p.pauseCtx?.matchId();
      if (!p.pauseCtx || clock === undefined || matchId === undefined) return;
      // Dry-run against this timestamp's effective state before clearing another timestamp.
      const scRec = st.records[scene];
      const curClock = scRec && !scRec.deleted && "Scene" in scRec.record ? (scRec.record.Scene.clock ?? null) : null;
      const sameClock = curClock === clock;
      const curRow = sameClock ? st.rowsIn<SceneState>("SceneState", scene)[0] : undefined;
      const dryState = curRow ? { id: curRow.id, more: curRow.r.more ?? {} } : undefined;
      const dryObjectives = sameClock ? p.objectives() : new Map();
      const drySeed = dryState && captured(dryState.more).obj_health ? undefined : seedObjHealthMap(p.pauseCtx.tl(), clock, p.art.model.markers);
      const dryOps = setObjectiveHealthOps(
        {
          scene,
          state: dryState,
          objectives: dryObjectives,
          markers: p.art.model.markers,
          mint: newRecordId,
          ...(p.markerStatus ? { shownStatus: p.markerStatus } : {}),
          ...(drySeed ? { seed: drySeed } : {}),
          upsertObjective: liveObjUpsert(st.records as never, p.pauseCtx.board, matchId, scene, dryObjectives),
        },
        m,
        pct,
        stage,
      );
      if (!dryOps.length) return;
      prepareLivePauseEdit(st, scene, clock);
      const { state: ss, prefix } = preparePausedSceneState(st, p.pauseCtx.board, matchId, scene);
      const seed = captured(ss.more).obj_health ? undefined : seedObjHealthMap(p.pauseCtx.tl(), clock, p.art.model.markers);
      const upsertObjective = liveObjUpsert(st.records as never, p.pauseCtx.board, matchId, scene, p.objectives());
      const ops = setObjectiveHealthOps(
        {
          scene,
          state: ss,
          objectives: p.objectives(),
          markers: p.art.model.markers,
          mint: newRecordId,
          ...(p.markerStatus ? { shownStatus: p.markerStatus } : {}),
          ...(seed ? { seed } : {}),
          upsertObjective,
        },
        m,
        pct,
        stage,
      );
      if (!ops.length) return;
      const clockOps = pauseClockOps(st.records as never, scene, clock);
      if (st.edit([...clockOps, ...prefix, ...ops]) && pct > 0) p.onEditObjHealth?.();
      return;
    }
    const ctx = objHealthCtx();
    if (!ctx) return;
    const ops = setObjectiveHealthOps(ctx, m, pct, stage);
    if (!ops.length) return;
    if (st.edit(ops) && pct > 0) p.onEditObjHealth?.();
  };
  /** A click on an objective: the whole group if it's in your selection, else just it. */
  const clickObjective = (m: Marker) => {
    const scene = p.scene;
    if (!scene || !canEditEntities()) return;
    const sel = p.objSelection();
    if (sel.has(m.key)) {
      const group = p.art.model.markers.filter((x) => sel.has(x.key));
      if (p.frame.player()) {
        const clock = p.frame.pauseClock?.();
        const matchId = p.pauseCtx?.matchId();
        if (!p.pauseCtx || clock === undefined || matchId === undefined) return;
        const scRec = st.records[scene];
        const curClock = scRec && !scRec.deleted && "Scene" in scRec.record ? (scRec.record.Scene.clock ?? null) : null;
        const dryObjectives = curClock === clock ? p.objectives() : new Map();
        const dryUpsert = liveObjUpsert(st.records as never, p.pauseCtx.board, matchId, scene, dryObjectives);
        if (!groupToggleOps(m, group, p.art.model.markers, dryObjectives, scene, newRecordId, p.markerStatus, curClock === clock ? objHealthCtx() : undefined, dryUpsert).length) return;
        prepareLivePauseEdit(st, scene, clock);
        const upsert = liveObjUpsert(st.records as never, p.pauseCtx.board, matchId, scene, p.objectives());
        const ops = groupToggleOps(m, group, p.art.model.markers, p.objectives(), scene, newRecordId, p.markerStatus, objHealthCtx(), upsert);
        if (ops.length) st.edit([...pauseClockOps(st.records as never, scene, clock), ...ops]);
        return;
      }
      const ops = groupToggleOps(m, group, p.art.model.markers, p.objectives(), scene, newRecordId, p.markerStatus, objHealthCtx());
      if (ops.length) st.edit(ops); // one transaction: one undo puts the whole group back
      return;
    }
    clearObjects();
    toggleObjective(m);
  };
  const toggleObjective = (m: Marker) => {
    const scene = p.scene;
    if (!scene || !canEditEntities()) return;
    if (p.frame.player()) {
      const clock = p.frame.pauseClock?.();
      const matchId = p.pauseCtx?.matchId();
      if (!p.pauseCtx || clock === undefined || matchId === undefined) return;
      const scRec = st.records[scene];
      const curClock = scRec && !scRec.deleted && "Scene" in scRec.record ? (scRec.record.Scene.clock ?? null) : null;
      const dryObjectives = curClock === clock ? p.objectives() : new Map();
      const dryUpsert = liveObjUpsert(st.records as never, p.pauseCtx.board, matchId, scene, dryObjectives);
      if (!toggleOps(m, p.art.model.markers, dryObjectives, scene, newRecordId, p.markerStatus, curClock === clock ? objHealthCtx() : undefined, dryUpsert).length) return;
      prepareLivePauseEdit(st, scene, clock);
      const upsert = liveObjUpsert(st.records as never, p.pauseCtx.board, matchId, scene, p.objectives());
      const ops = toggleOps(m, p.art.model.markers, p.objectives(), scene, newRecordId, p.markerStatus, objHealthCtx(), upsert);
      if (ops.length) st.edit([...pauseClockOps(st.records as never, scene, clock), ...ops]);
      return;
    }
    const ops = toggleOps(m, p.art.model.markers, p.objectives(), scene, newRecordId, p.markerStatus, objHealthCtx());
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
    if (!lane || !scene || !canEditEntities()) return;
    e.preventDefault();
    e.stopPropagation();
    const existing = p.waves().get(key);
    const matchId = p.frame.player() ? p.pauseCtx?.matchId() : undefined;
    const id = existing?.id ?? (p.frame.player() && p.pauseCtx && matchId !== undefined ? liveWaveId(p.pauseCtx.board, matchId, key) : newRecordId());
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
        if (p.frame.player()) {
          const clock = p.frame.pauseClock?.();
          if (!p.pauseCtx || matchId === undefined || clock === undefined) return;
          if (d.t === Math.round(p.splitOf(key))) return;
          prepareLivePauseEdit(st, scene, clock);
          const ops = liveWaveUpsertOps(st.records as never, p.pauseCtx.board, matchId, scene, clock, p.waves(), key, d.t);
          if (ops.length) st.edit(ops);
          return;
        }
        if (existing) {
          if (existing.t !== d.t) st.edit([{ Set: { id, value: { WavePos: d.t } } }]);
        } else st.edit([{ Create: { id, record: { Wave: { scene, lane: key, t: d.t } } } }]);
      },
    );
  };

  /** Pan by dragging: middle or right button anywhere, Space+drag, or a viewer's Look drag. */
  /** Pointers whose gesture is a pan: a second finger turns one into a pinch at any age. */
  const panning = new Set<number>();
  let tokenTap: ((tok: Element, e: PointerEvent) => void) | undefined;
  const pan = (e: PointerEvent, onClick?: (at: Pt) => void) => {
    const svg = p.svg()!;
    panning.add(e.pointerId);
    e.preventDefault();
    e.stopPropagation(); // a pan never also drags the hero under the pointer
    const perPx = svg.viewBox.baseVal.width / svg.getBoundingClientRect().width;
    const at = svgPoint(svg, e);
    const first = { x: e.clientX, y: e.clientY };
    const slop = e.pointerType === "touch" ? 10 : 4;
    let last = first;
    let far = 0;
    let moved = false;
    track(
      e,
      (_, ev) => {
        far = Math.max(far, Math.hypot(ev.clientX - first.x, ev.clientY - first.y));
        if (!moved) {
          if (far < slop) return;
          moved = true;
        }
        p.onPan((ev.clientX - last.x) * perPx, (ev.clientY - last.y) * perPx);
        last = { x: ev.clientX, y: ev.clientY };
      },
      (_, ok) => {
        panning.delete(e.pointerId);
        if (ok && !moved) onClick?.(at);
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
  const pingWorld = (w: WorldPos) => {
    pingN += 1;
    st.presence({ ping: { at: w, n: pingN } });
    showPing({ key: `me:${pingN}`, at: w, color: p.myColor, name: "" });
    clearTimeout(pingClear);
    pingClear = setTimeout(() => st.presence({ ping: null }), PING_MS);
  };
  const ping = (at: Pt) => pingWorld(world(at));
  p.bindPing?.(pingWorld);
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

  // ---- moving placed things (Select): arrows whole or by one end, strokes whole ----
  const [movingArrow, setMovingArrow] = createSignal<{ id: RecordId; from: WorldPos; to: WorldPos }>();
  const [movingStroke, setMovingStroke] = createSignal<{ id: RecordId; d: { x: number; y: number } }>();
  /** A press that didn't move: what a press on the map there would have done (an objective). */
  const pressThrough = (at: Pt) => {
    if (!canEditEntities()) return;
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

  /** Select on empty map: drag a rectangle to select heroes (Shift adds); a click clears. */
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
        const slotById = new Map(st.roster().map((s) => [s.id, s.slot]));
        const heroHits = !canEditEntities()
          ? []
          : st.playersIn(p.tokenScene ?? p.scene).flatMap((pl) => {
              if (p.frame.player()) {
                const sl = slotById.get(pl.state.slot);
                if (!sl) return [];
                const h = p.frame.ms().hero(slotKey(sl.team, sl.slot));
                const pos = h.pos() ?? (!h.alive() && !pl.state.alive && pl.state.placed ? h.last() : null);
                return pos ? [{ id: pl.id, at: view(pos) }] : [];
              }
              return pl.state.placed ? [{ id: pl.id, at: view(pl.state.pos) }] : [];
            });
        const objHits = !canEditEntities()
          ? []
          : p.art.model.markers
              .filter((m) => !isFurniture(m.kind) && (p.showHidden || p.objectives().get(m.key)?.status !== "Hidden"))
              .map((m) => ({ key: m.key, at: mapToView(m.at, p.vp) }));
        const picked = marqueePick(rect, heroHits, objHits);
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

  // ---- a placed thing's menu: a comment's side, and a colour (feedback #59, #60) ----
  const [menu, setMenu] = createSignal<{ kind: Placed; id: RecordId; at: { x: number; y: number } }>();
  /** The placed thing under a right click, if this person may edit it. */
  const placedAt = (target: Element): { kind: Placed; id: RecordId } | undefined => {
    if (!editor() || target.closest?.(".co.editing")) return undefined;
    const co = target.closest?.("[data-callout]")?.getAttribute("data-callout");
    if (co && callouts().some((c) => c.id === co)) return { kind: "Callout", id: co as RecordId };
    const arrow = target.closest?.("[data-arrow]")?.getAttribute("data-arrow");
    if (arrow && arrows().some((a) => a.id === arrow)) return { kind: "Arrow", id: arrow as RecordId };
    const stroke = target.closest?.("[data-stroke]")?.getAttribute("data-stroke");
    if (stroke && strokes().some((x) => x.id === stroke)) return { kind: "Stroke", id: stroke as RecordId };
    return undefined;
  };
  /** A placed thing's record as it is now (another editor may change or erase it). */
  const placedRecord = (m: { kind: Placed; id: RecordId }): Callout | Arrow | Stroke | undefined => {
    if (m.kind === "Callout") return callouts().find((c) => c.id === m.id)?.r;
    if (m.kind === "Arrow") return arrows().find((a) => a.id === m.id)?.r;
    return strokes().find((x) => x.id === m.id)?.r;
  };
  const menuRecord = createMemo(() => {
    const m = menu();
    return m ? placedRecord(m) : undefined;
  });
  // Gone (erased, undone, another scene), or no longer this person's to edit: the menu closes.
  createEffect(() => {
    if (menu() && (!menuRecord() || !editor())) setMenu(undefined);
  });
  const menuView = (m: { kind: Placed; id: RecordId; at: { x: number; y: number } }) => {
    // By the record, not the menu's: an item runs after the menu has closed (`ContextMenu`).
    const colour = () => (placedRecord(m) as { color?: number | null } | undefined)?.color;
    const side = () => (placedRecord(m) as Callout | undefined)?.side;
    const items: MenuItem[] = [];
    // Pins (the phone) have no side.
    if (m.kind === "Callout" && !p.compactCallouts) {
      for (const to of SIDES)
        items.push({
          label: to,
          testid: `comment-side-${to.toLowerCase()}`,
          get checked() {
            return (side() ?? "Above") === to;
          },
          run: () => {
            const ops = sideOps(m.id, side(), to);
            if (ops.length) st.edit(ops);
          },
        });
    }
    PALETTE.forEach((c, i) =>
      items.push({
        label: c.name,
        testid: `recolour-${i}`,
        swatch: c.hex,
        get checked() {
          return colour() === i;
        },
        run: () => {
          const ops = recolourOps(m.kind, m.id, colour(), i);
          if (ops.length) st.edit(ops);
        },
      }),
    );
    // Back to no colour (a comment's own, an arrow's team's): a stroke's ink always has one.
    if (m.kind !== "Stroke")
      items.push({
        label: "No colour",
        testid: "recolour-none",
        get checked() {
          return colour() == null;
        },
        run: () => {
          const ops = recolourOps(m.kind, m.id, colour(), null);
          if (ops.length) st.edit(ops);
        },
      });
    return <ContextMenu at={m.at} label={m.kind === "Callout" ? "Comment" : m.kind === "Arrow" ? "Arrow" : "Drawing"} testid="placed-menu" items={items} onClose={() => setMenu(undefined)} />;
  };

  // ---- Doorman doorway menu (right-click / long-press on `.pl-door`), objective health menu, & empty-map menu ----
  const [doorMenu, setDoorMenu] = createSignal<{ index: number; expect: DoorIdentity; at: { x: number; y: number } }>();
  const [objMenu, setObjMenu] = createSignal<{ key: string; scene: RecordId | undefined; at: { x: number; y: number } }>();
  const [mapMenu, setMapMenu] = createSignal<{ at: { x: number; y: number }; pos: WorldPos }>();
  createEffect(() => {
    const m = doorMenu();
    if (m && (!editor() || !canEditEntities() || resolveDoorIndex(sceneDoors(), m.index, m.expect) === undefined)) setDoorMenu(undefined);
  });
  createEffect(() => {
    const m = objMenu();
    if (m && (!editor() || !canEditEntities() || m.scene !== p.scene)) setObjMenu(undefined);
  });
  createEffect(() => {
    if (mapMenu() && (!editor() || !canEditEntities())) setMapMenu(undefined);
  });
  const doorMenuView = (m: { index: number; expect: DoorIdentity; at: { x: number; y: number } }) => {
    const resolved = () => resolveDoorIndex(sceneDoors(), m.index, m.expect);
    const cur = () => {
      const i = resolved();
      return i !== undefined ? sceneDoors()[i] : undefined;
    };
    const items: MenuItem[] = [];
    const initial = cur();
    if (initial && initial.partner === null) {
      items.push({
        label: "Link second door",
        testid: "door-menu-link",
        run: () => {
          const i = resolved();
          const d = i !== undefined ? sceneDoors()[i] : undefined;
          if (i !== undefined && d && d.partner === null) p.setPlacingDoor?.({ team: d.team, door1: d.at, linkIndex: i, linkExpect: m.expect });
        },
      });
    } else if (initial) {
      items.push({
        label: "Unlink door",
        testid: "door-menu-unlink",
        run: () => {
          commitDoorEdit((ctx) => unlinkDoorOps(ctx, m.index, m.expect));
        },
      });
    }
    items.push(
      {
        get label() {
          return (cur()?.inSight ?? true) ? "Mark not seen" : "Mark in vision";
        },
        testid: "door-menu-vision",
        run: () => {
          commitDoorEdit((ctx) => toggleDoorSightOps(ctx, m.index, m.expect));
        },
      },
      {
        label: "Remove doorway",
        testid: "door-menu-remove",
        run: () => {
          commitDoorEdit((ctx) => removeDoorwayOps(ctx, m.index, m.expect));
        },
      },
    );
    return <ContextMenu at={m.at} label="Doorway" testid="door-menu" items={items} onClose={() => setDoorMenu(undefined)} />;
  };
  const mapMenuView = (m: { at: { x: number; y: number }; pos: WorldPos }) => {
    let amberHas = false;
    let sapphireHas = false;
    for (const s of st.roster()) {
      const h = p.frame.ms().hero(slotKey(s.slot.team, s.slot.slot)).hero();
      if (h !== DOORMAN_HERO_ID) continue;
      if (s.slot.team === "Amber") amberHas = true;
      else sapphireHas = true;
    }
    const items: MenuItem[] = [];
    if (amberHas !== sapphireHas) {
      const team = amberHas ? "amber" : "sapphire";
      items.push({
        label: "Place doorway",
        testid: "map-menu-doorway",
        run: () => p.setPlacingDoor?.({ team, door1: m.pos }),
      });
    } else {
      const order: Array<"amber" | "sapphire"> = p.vp === "sapphire" ? ["sapphire", "amber"] : ["amber", "sapphire"];
      for (const team of order) {
        items.push({
          label: `Place ${teamShort(team)} doorway`,
          testid: `map-menu-doorway-${team}`,
          run: () => p.setPlacingDoor?.({ team, door1: m.pos }),
        });
      }
    }
    return <ContextMenu at={m.at} label="Map" testid="map-menu" items={items} onClose={() => setMapMenu(undefined)} />;
  };
  const objMenuView = (m: { key: string; scene: RecordId | undefined; at: { x: number; y: number } }) => {
    const marker = p.art.model.markers.find((x) => x.key === m.key);
    if (!marker) return null;
    const status = () => p.markerStatus?.(marker.key) ?? p.objectives().get(marker.key)?.status;
    const isDown = () => status() === "Destroyed" || p.frame.ms().marker(marker.key).down();
    const curPct = () => {
      if (isDown()) return 0;
      return p.frame.ms().marker(marker.key).health()?.pct ?? 100;
    };
    const isStage2 = () => status() === "Stage2";
    const items: MenuItem[] =
      marker.kind === "t3"
        ? [
            {
              label: "Stage 1 · 100%",
              testid: "obj-menu-stage1",
              get checked() {
                return !isDown() && !isStage2() && curPct() === 100;
              },
              run: () => commitObjHealth(marker, 100, 1),
            },
            {
              label: "Stage 2 (Weakened) · 100%",
              testid: "obj-menu-stage2",
              get checked() {
                return !isDown() && isStage2() && curPct() === 100;
              },
              run: () => commitObjHealth(marker, 100, 2),
            },
            ...([75, 50, 25] as const).map((pct) => ({
              label: `${pct}%`,
              testid: `obj-menu-hp-${pct}`,
              get checked() {
                return !isDown() && curPct() === pct;
              },
              run: () => commitObjHealth(marker, pct),
            })),
            {
              label: "Destroyed",
              testid: "obj-menu-destroyed",
              get checked() {
                return isDown();
              },
              run: () => commitObjHealth(marker, 0),
            },
          ]
        : [
            ...([100, 75, 50, 25] as const).map((pct) => ({
              label: `${pct}%`,
              testid: `obj-menu-hp-${pct}`,
              get checked() {
                return !isDown() && curPct() === pct;
              },
              run: () => commitObjHealth(marker, pct),
            })),
            {
              label: marker.kind === "midboss" ? "Cleared" : "Destroyed",
              testid: "obj-menu-destroyed",
              get checked() {
                return isDown();
              },
              run: () => commitObjHealth(marker, 0),
            },
          ];
    const menuLabel = marker.kind === "t3" ? teamName(marker.team) : (HEALTH_NAME[marker.kind] ?? "Objective");
    return <ContextMenu at={m.at} label={menuLabel} testid="obj-menu" items={items} onClose={() => setObjMenu(undefined)} />;
  };

  // A finger held still on or beside a placed thing (Select): the gesture it started (a drag, a
  // tap that opens a comment) ends uncommitted, as a pinch ends it, and the menu opens there. Only
  // what is on top at each point counts, so nothing is found through a hero or a sheet.
  let holding: (() => void) | undefined;
  onCleanup(() => holding?.());
  const placedNear = (svg: SVGSVGElement, x: number, y: number) => {
    for (const q of reachPoints(x, y)) {
      const el = document.elementFromPoint(q.x, q.y);
      const placed = el && svg.contains(el) ? placedAt(el) : undefined;
      if (placed) return placed;
    }
    return undefined;
  };
  const hold = (e: PointerEvent) => {
    holding?.();
    const at = { x: e.clientX, y: e.clientY };
    holding = longPress(e, () => {
      holding = undefined;
      const svg = p.svg();
      // Not while a comment is being typed: the menu would take the focus, and the blur commits
      // the text (an empty field deletes the comment).
      if (!svg || p.tool !== "select" || !editor() || editing() || p.placingDoor?.()) return;
      const placed = placedNear(svg, at.x, at.y);
      if (placed) {
        svg.dispatchEvent(new PointerEvent("pointercancel", { pointerId: e.pointerId, pointerType: "touch", bubbles: true, clientX: at.x, clientY: at.y }));
        swallowLiftClick(e.pointerId);
        setMenu({ ...placed, at });
        return;
      }
      if (!canEditEntities()) return;
      const doorIdx = doorNearClient(svg, at.x, at.y);
      if (doorIdx !== undefined) {
        const d = sceneDoors().find((x) => x.id === doorIdx);
        if (d) {
          svg.dispatchEvent(new PointerEvent("pointercancel", { pointerId: e.pointerId, pointerType: "touch", bubbles: true, clientX: at.x, clientY: at.y }));
          swallowLiftClick(e.pointerId);
          setDoorMenu({ index: doorIdx, expect: doorIdentity(d), at });
          return;
        }
      }
      const topEl = document.elementFromPoint(at.x, at.y);
      const svgPt = svgPoint(svg, { clientX: at.x, clientY: at.y });
      if (topEl && svg.contains(topEl) && !topEl.closest?.(".tok[data-player], .pl-skull, .co.editing")) {
        const hitObj = objectiveAt(svgPt);
        if (hitObj && isHealthKind(hitObj.kind)) {
          svg.dispatchEvent(new PointerEvent("pointercancel", { pointerId: e.pointerId, pointerType: "touch", bubbles: true, clientX: at.x, clientY: at.y }));
          swallowLiftClick(e.pointerId);
          setObjMenu({ key: hitObj.key, scene: p.scene, at });
          return;
        }
        if (!topEl.closest?.(".wave-hit") && inPlayableDisc(svgPt) && !hitObj) {
          svg.dispatchEvent(new PointerEvent("pointercancel", { pointerId: e.pointerId, pointerType: "touch", bubbles: true, clientX: at.x, clientY: at.y }));
          swallowLiftClick(e.pointerId);
          setMapMenu({ at, pos: clampToDisc(viewToWorld(svgPt, p.vp)) });
        }
      }
    });
  };

  const down = (e: PointerEvent) => {
    const svg = p.svg();
    if (!svg) return;
    // A hero, a death skull, a wave's handle and the comment being typed keep their own press,
    // whatever lies beside them.
    if (e.pointerType === "touch" && e.button === 0 && p.tool === "select" && !p.placingDoor?.() && !(e.target as Element).closest?.(".tok, .pl-skull, .wave-hit, .co.editing")) hold(e);
    // A press anywhere but on a comment closes the open one.
    const onComment = (e.target as Element).closest?.("[data-callout]")?.getAttribute("data-callout");
    if (!onComment) p.setOpenComment(undefined);
    if (e.button === 1) {
      // Middle: a click pings (anyone, viewers too), a drag pans.
      pan(e, ping);
      return;
    }
    if (e.button === 2 || (e.button === 0 && p.spaceHeld())) {
      // Right-clicking while placing a doorway cancels the preview with 0 ops.
      if (e.button === 2 && p.placingDoor?.()) {
        e.preventDefault();
        e.stopPropagation();
        p.setPlacingDoor?.(undefined);
        return;
      }
      // A right drag pans; a right click on a hero's token opens its menu, as on its portrait,
      // and on a placed comment, arrow, stroke, door, or empty map in Select, its own.
      const target = e.target as Element;
      let tok = e.button === 2 && p.onHeroMenu ? target.closest?.(".tok[data-player]")?.getAttribute("data-player") : undefined;
      if (!tok && e.button === 2 && p.onHeroMenu && p.frame.player() && canEditEntities()) {
        const skullSlot = target.closest?.(".pl-skull[data-slot]")?.getAttribute("data-slot")?.toLowerCase();
        if (skullSlot) {
          const slotRec = st.roster().find((s) => slotKey(s.slot.team, s.slot.slot) === skullSlot);
          const pl = slotRec && st.playersIn(p.tokenScene ?? p.scene).find((x) => x.state.slot === slotRec.id);
          if (pl) tok = pl.id;
        }
      }
      const placed = e.button === 2 && !tok ? placedAt(target) : undefined;
      const doorIdx = e.button === 2 && !tok && !placed && canEditEntities() && editor() && p.tool === "select" ? doorAtEl(target) : undefined;
      const at = { x: e.clientX, y: e.clientY };
      const svgPt = svgPoint(svg, e);
      const hitObj =
        e.button === 2 &&
        !tok &&
        !placed &&
        doorIdx === undefined &&
        canEditEntities() &&
        editor() &&
        p.tool === "select" &&
        !target.closest?.(".pl-skull, .co.editing")
          ? objectiveAt(svgPt)
          : undefined;
      const obj = hitObj && isHealthKind(hitObj.kind) ? hitObj : undefined;
      const canMapMenu =
        e.button === 2 &&
        !tok &&
        !placed &&
        doorIdx === undefined &&
        !hitObj &&
        canEditEntities() &&
        editor() &&
        p.tool === "select" &&
        !target.closest?.(".pl-skull, .wave-hit, .co.editing") &&
        inPlayableDisc(svgPt);
      pan(
        e,
        tok
          ? () => p.onHeroMenu?.(tok as RecordId, at, true)
          : placed
            ? () => setMenu({ ...placed, at })
            : doorIdx !== undefined
              ? () => {
                  const d = sceneDoors().find((x) => x.id === doorIdx);
                  if (d) setDoorMenu({ index: doorIdx, expect: doorIdentity(d), at });
                }
              : obj
                ? () => setObjMenu({ key: obj.key, scene: p.scene, at })
                : canMapMenu
                  ? () => setMapMenu({ at, pos: clampToDisc(viewToWorld(svgPt, p.vp)) })
                  : undefined,
      );
      return;
    }
    if (e.button !== 0) return;
    const start = svgPoint(svg, e);
    // Two-step manual doorway placement (Step 1 armed -> Step 2 Door 1 -> commit pair or unpaired).
    if (p.placingDoor?.() && canEditEntities() && editor()) {
      e.preventDefault();
      e.stopPropagation();
      const isTouch = e.pointerType === "touch";
      if (isTouch) {
        const cur = p.placingDoor();
        if (cur?.door1) p.setPlacingDoor?.({ ...cur, pointer: start, touch: true });
      }
      track(
        e,
        (pt, ev) => {
          const cur = p.placingDoor?.();
          if (cur) p.setPlacingDoor?.({ ...cur, pointer: pt, touch: ev.pointerType === "touch" });
        },
        (pt, ok) => {
          if (!ok) return;
          const pl = p.placingDoor?.();
          if (!pl) return;
          if (!pl.door1) {
            p.setPlacingDoor?.({ team: pl.team, door1: clampToDisc(viewToWorld(pt, p.vp)), pointer: pt, touch: isTouch });
            return;
          }
          const dist = Math.hypot(pt.x - view(pl.door1).x, pt.y - view(pl.door1).y);
          const minDist = isTouch ? Math.max(DOOR_PAIR_MIN_DIST, DOOR_R * p.k * 1.5) : DOOR_PAIR_MIN_DIST;
          if (dist < minDist) {
            if (pl.linkIndex === undefined) {
              commitDoorEdit((ctx) => placeDoorwayOps(ctx, pl.team, pl.door1!));
            }
          } else {
            const door2 = clampToDisc(viewToWorld(pt, p.vp));
            commitDoorEdit((ctx) =>
              pl.linkIndex !== undefined
                ? linkSecondDoorOps(ctx, pl.linkIndex, door2, pl.linkExpect)
                : placeDoorwayOps(ctx, pl.team, pl.door1!, door2),
            );
          }
          p.setPlacingDoor?.(undefined);
        },
      );
      return;
    }
    const tool = p.tool;
    if (tool === "laser") {
      e.preventDefault();
      pushLaser(start, true);
      track(e, (pt) => pushLaser(pt), () => {});
      return;
    }
    if (tool === "select") {
      // A death skull with a recap handles its own press (Skulls.tsx).
      if ((e.target as Element).closest?.(".pl-skull[data-recap]")) return;
      if (!editor()) {
        if (onComment) return; // the comment handles its own click
        const tok = (e.target as Element).closest?.('.tok[data-slot]:not([data-fading="out"])') ?? undefined;
        pan(e, tok ? () => tokenTap?.(tok, e) : undefined); // Look: dragging the map pans; tapping a token opens/tracks it
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
      if (canEditEntities()) {
        const doorIdx = doorAtEl(target);
        if (doorIdx !== undefined) {
          moveDoor(e, doorIdx);
          return;
        }
        const m = objectiveAt(start);
        if (m) {
          e.preventDefault();
          if (p.scene && isHealthKind(m.kind) && !e.shiftKey) {
            const startScene = p.scene;
            const startClientX = e.clientX;
            const startClientY = e.clientY;
            const curStatus = p.markerStatus?.(m.key) ?? p.objectives().get(m.key)?.status;
            const curDown = curStatus === "Destroyed" || p.frame.ms().marker(m.key).down();
            const curHealth = p.frame.ms().marker(m.key).health();
            const startPct = curDown ? 0 : (curHealth?.pct ?? 100);
            const startStage: 1 | 2 | undefined = m.kind === "t3" ? (curStatus === "Stage2" ? 2 : 1) : undefined;
            const focusId = p.objectives().get(m.key)?.id ?? startScene;
            let scrubbing = false;
            let lastPct = startPct;
            track(
              e,
              (_, ev) => {
                if (p.scene !== startScene) {
                  if (scrubbing) {
                    scrubbing = false;
                    p.setDragObjHealth?.(undefined);
                    st.presence({ focus: null });
                  }
                  return;
                }
                const distPx = Math.hypot(ev.clientX - startClientX, ev.clientY - startClientY);
                if (!scrubbing) {
                  if (distPx < 6) return;
                  scrubbing = true;
                  holding?.();
                  holding = undefined;
                  clearObjects();
                  st.presence({ focus: focusId });
                }
                const dyPx = startClientY - ev.clientY;
                const raw = Math.max(0, Math.min(100, startPct + (dyPx / 80) * 100));
                const pct = ev.shiftKey ? Math.round(raw / 5) * 5 : Math.round(raw);
                lastPct = pct;
                p.setDragObjHealth?.({ key: m.key, pct, ...(startStage !== undefined ? { stage: startStage } : {}) });
              },
              (_, ok, ev) => {
                p.setDragObjHealth?.(undefined);
                if (scrubbing) {
                  st.presence({ focus: null });
                  if (ok && p.scene === startScene) commitObjHealth(m, lastPct, startStage);
                } else if (ok && p.scene === startScene && Math.hypot(ev.clientX - startClientX, ev.clientY - startClientY) < 6) {
                  clickObjective(m);
                }
              },
            );
            return;
          }
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
      }
      // A finger on empty map pans (the marquee stays mouse and pen); a tap clears, as a click.
      if (e.pointerType === "touch") {
        pan(e, () => {
          p.setSelection(new Set());
          p.setObjSelection(new Set());
        });
        return;
      }
      marquee(e, start);
      return;
    }
    // Making things needs a scene to make them in (in Player, its live layer, which a viewer or a
    // board before its first Player session doesn't have): without one the tools do nothing.
    // The scene is the one the gesture started on.
    const target = p.scene;
    if (!editor() || !target) return;
    if (tool === "draw") {
      e.preventDefault();
      setDrawing([start]);
      // Others see the stroke as it's drawn (through presence, like the laser), then the record:
      // a downsampled preview, at most once per presence tick.
      let liveTimer: ReturnType<typeof setTimeout> | undefined;
      const sendLive = () => {
        liveTimer = undefined;
        if (drawing()) st.presence({ ink: liveInk(drawing()!, p.ink, world) });
      };
      const live = () => (liveTimer ??= setTimeout(sendLive, PRESENCE_MS));
      sendLive();
      track(
        e,
        (pt) => {
          setDrawing([...(drawing() ?? []), pt]);
          live();
        },
        (_, ok) => {
          clearTimeout(liveTimer);
          const pts = drawing() ?? [];
          setDrawing(undefined);
          st.presence({ ink: null });
          if (!ok || pts.length === 0) return;
          const fitted = fitStroke(pts, MAX_STROKE_POINTS);
          // A tap is a dot: the schema wants at least two points, so the dot repeats its one.
          const points = (fitted.length === 1 ? [fitted[0]!, fitted[0]!] : fitted).map(world);
          st.edit([{ Create: { id: newRecordId(), record: { Stroke: { scene: target, points, color: p.ink, width: INK_WIDTH } } } }]);
        },
      );
    } else if (tool === "arrow") {
      e.preventDefault();
      // Starting on a hero (or a scene doorway): the arrow takes its team and starts at its centre.
      const tok = (e.target as Element).closest?.(".tok[data-player]");
      const pid = tok?.getAttribute("data-player");
      const rec = pid ? st.records[pid] : undefined;
      let from = start;
      let team: "Amber" | "Sapphire" | null = null;
      if (rec && "PlayerState" in rec.record) {
        const ps = rec.record.PlayerState;
        team = teamOfSlot().get(ps.slot) ?? null;
        if (p.frame.player()) {
          const sl = st.roster().find((s) => s.id === ps.slot);
          const h = sl ? p.frame.ms().hero(slotKey(sl.slot.team, sl.slot.slot)) : undefined;
          const pos = h?.pos() ?? h?.last();
          from = pos ? view(pos) : start;
        } else {
          from = view(ps.pos);
        }
      } else if (canEditEntities()) {
        const doorIdx = doorAtEl(e.target as Element);
        const door = doorIdx !== undefined ? sceneDoors().find((d) => d.id === doorIdx) : undefined;
        if (door) {
          from = view(door.at);
          team = door.team === "amber" ? "Amber" : "Sapphire";
        }
      }
      setArrowing({ from, to: from, team });
      track(
        e,
        (pt) => setArrowing({ ...arrowing()!, to: pt }),
        (_, ok) => {
          const a = arrowing();
          setArrowing(undefined);
          if (!ok || !a || Math.hypot(a.to.x - a.from.x, a.to.y - a.from.y) < 12) return;
          st.edit([{ Create: { id: newRecordId(), record: { Arrow: { scene: target, from: world(a.from), to: world(a.to), team: a.team, color: p.ink } } } }]);
        },
      );
    } else if (tool === "callout") {
      e.preventDefault();
      const hit = (e.target as Element).closest?.("[data-callout]")?.getAttribute("data-callout");
      const c = hit ? callouts().find((x) => x.id === hit) : undefined;
      openEditor(c ? { id: c.id, pos: c.r.pos, text: c.r.text } : { id: undefined, pos: world(start), text: "", scene: target });
    } else if (tool === "erase") {
      e.preventDefault();
      const hits = new Set<RecordId>();
      const doorHits = new Map<number, DoorIdentity>();
      const add = (ev: PointerEvent) => {
        const hit = eraseTargetAtPoint(ev.clientX, ev.clientY);
        if (!hit) return;
        if (hit.kind === "record") {
          if (!hits.has(hit.id)) {
            hits.add(hit.id);
            setErasing(new Set(hits));
          }
        } else if (!doorHits.has(hit.index)) {
          const d = sceneDoors().find((x) => x.id === hit.index);
          if (!d) return;
          doorHits.set(hit.index, doorIdentity(d));
          p.setErasingDoors?.(new Set(doorHits.keys()));
        }
      };
      add(e);
      track(
        e,
        (_, ev) => add(ev),
        (_, ok) => {
          setErasing(new Set<RecordId>());
          p.setErasingDoors?.(new Set<number>());
          if (!ok) return;
          const ops: Op[] = [...hits].map((id): Op => ({ Delete: { id } }));
          if (p.frame.player()) {
            // Keep live-ink annotation deletes separate from live-entity SceneState doorway edits
            // so Play's `dropHistoryFor(liveEntityRecordIds)` never drops live-ink undo (D1/B2).
            if (ops.length) st.edit(ops);
            if (doorHits.size) {
              commitDoorEdit((ctx) => removeDoorwaysOps(ctx, [...doorHits.entries()].map(([index, expect]) => ({ index, expect }))));
            }
          } else if (doorHits.size) {
            commitDoorEdit(
              (ctx) => removeDoorwaysOps(ctx, [...doorHits.entries()].map(([index, expect]) => ({ index, expect }))),
              ops,
            );
          } else if (ops.length) {
            st.edit(ops);
          }
        },
      );
    }
  };

  onMount(() => {
    const svg = p.svg();
    if (!svg) return;
    // Your cursor, for everyone looking at the same scene.
    // Mouse and pen only: a finger's "cursor" would jump to wherever it pans or taps. Peers see
    // a touch user's laser, stroke, drag and ping instead.
    const cursor = (e: PointerEvent) => {
      if (e.pointerType === "touch") return;
      const pt = svgPoint(svg, e);
      st.presence({ cursor: world(pt) });
      const pl = p.placingDoor?.();
      if (pl) p.setPlacingDoor?.({ ...pl, pointer: pt, touch: false });
    };
    const leave = () => st.presence({ cursor: null });
    const wheel = (e: WheelEvent) => {
      if (e.ctrlKey && Math.abs(e.deltaY) < 1) return;
      e.preventDefault();
      p.onZoom(svgPoint(svg, e), Math.exp(Math.max(-1, Math.min(1, e.deltaY / 300))));
    };
    // Hover + Erase's key (D) deletes the placed thing (or doorway) under the pointer, whatever
    // the tool (operator, 2026-11-07). Ahead of the toolbar's Erase, which still applies over empty map.
    const eraseKey = TOOLS.find((x) => x.tool === "erase")!.key.toLowerCase();
    let hover: { x: number; y: number } | undefined;
    const trackHover = (e: PointerEvent) => (hover = { x: e.clientX, y: e.clientY });
    const untrackHover = () => (hover = undefined);
    const del = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      if (
        document.querySelector(
          ".backdrop, .ctx-menu, .more-menu, .clear-pop, .scenes.drawer, .phone:not(.phone-player) .p-sheet, .phone-player .p-sheet:not([data-testid=phone-events-sheet]), [data-testid=games-sheet]",
        )
      )
        return;
      // Active doorway placement handles Escape (cancel) and Enter (commit unpaired Door 1).
      const pl = p.placingDoor?.();
      if (pl && canEditEntities() && editor()) {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopImmediatePropagation();
          p.setPlacingDoor?.(undefined);
          return;
        }
        if (e.key === "Enter" && !e.repeat) {
          e.preventDefault();
          e.stopImmediatePropagation();
          if (pl.door1 && pl.linkIndex === undefined) {
            commitDoorEdit((ctx) => placeDoorwayOps(ctx, pl.team, pl.door1!));
          }
          p.setPlacingDoor?.(undefined);
          return;
        }
      }
      if (e.key.toLowerCase() !== eraseKey || e.ctrlKey || e.metaKey || e.altKey || e.repeat || !hover || !editor()) return;
      const id = erasableAtPoint(hover.x, hover.y);
      if (id) {
        e.preventDefault();
        e.stopImmediatePropagation();
        st.edit([{ Delete: { id } }]);
        return;
      }
      if (canEditEntities()) {
        const target = eraseTargetAtPoint(hover.x, hover.y);
        const doorIdx = target?.kind === "door" ? target.index : doorNearView(svgPoint(svg, { clientX: hover.x, clientY: hover.y }));
        if (doorIdx !== undefined) {
          const d = sceneDoors().find((x) => x.id === doorIdx);
          if (d) {
            const committed = commitDoorEdit((ctx) => removeDoorwayOps(ctx, doorIdx, doorIdentity(d)));
            if (committed) {
              e.preventDefault();
              e.stopImmediatePropagation();
            }
          }
        }
      }
    };
    window.addEventListener("keydown", del, true);
    svg.addEventListener("pointermove", trackHover);
    svg.addEventListener("pointerleave", untrackHover);
    onCleanup(() => {
      window.removeEventListener("keydown", del, true);
      svg.removeEventListener("pointermove", trackHover);
      svg.removeEventListener("pointerleave", untrackHover);
    });
    const untouch = touchGestures(svg, { onPan: (dx, dy, fromPinch) => p.onPan(dx, dy, fromPinch), onZoom: (at, k) => p.onZoom(at, k), isPan: (id) => panning.has(id), toView: (x, y) => svgPoint(svg, { clientX: x, clientY: y }) });
    onCleanup(untouch);
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

  // ---- callouts: drag (Select), edit in place (double-click, or the Callout tool) ----
  const openEditor = (ed: { id: RecordId | undefined; pos: WorldPos; text: string; scene?: RecordId }) => {
    setEditing(ed);
    st.presence({ focus: ed.id ?? null });
  };
  const closeEditor = (commit: boolean, text?: string) => {
    const ed = editing();
    setEditing(undefined);
    st.presence({ focus: null });
    p.setOpenComment(undefined); // collapses after editing (unless all are open)
    // A new comment goes in the scene it was started on.
    const scene = ed?.scene ?? p.scene;
    if (!commit || !ed || !scene) return;
    const t = (text ?? "").trim().slice(0, MAX_CALLOUT);
    if (ed.id === undefined) {
      if (t) st.edit([{ Create: { id: newRecordId(), record: { Callout: { scene, pos: ed.pos, text: t, color: p.ink } } } }]);
    } else if (!t) st.edit([{ Delete: { id: ed.id } }]);
    else if (t !== ed.text) st.edit([{ Set: { id: ed.id, value: { CalloutText: t } } }]);
  };

  // Double-click by hand: the drag captures the pointer on the map, so the callout itself never
  // receives a dblclick event.
  let lastTap: { id: RecordId; t: number } | undefined;
  const calloutDown = (c: Rec<Callout>, e: PointerEvent) => {
    if (p.tool !== "select" || e.button !== 0) return;
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

  /** My laser, one trail per gesture. */
  const myLaser = createMemo(() => laserRuns(laser(), laserStarts(laser())));
  const remoteLasers = createMemo(() => st.peerList().filter((x) => (x.state?.laser.length ?? 0) > 0 && x.state?.scene === p.scene));
  // The fade's clock: a frame at a time while any trail shows, mine or a peer's, so every point
  // fades by its own age whether or not its pointer moves (#42).
  const [laserNow, setLaserNow] = createSignal(performance.now());
  let laserFrame = 0;
  const laserFrameTick = () => {
    laserFrame = 0;
    setLaserNow(performance.now());
    if (laser().length || remoteLasers().length) laserFrame = requestAnimationFrame(laserFrameTick);
  };
  createEffect(() => {
    if ((laser().length || remoteLasers().length) && !laserFrame) {
      setLaserNow(performance.now());
      laserFrame = requestAnimationFrame(laserFrameTick);
    }
  });
  onCleanup(() => cancelAnimationFrame(laserFrame));
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
                <path class={cx("arw", arrowClass(a.r.team))} d={polyline([f(), shaftEnd(f(), t(), 10)])} style={a.r.color != null ? { stroke: colorOf(a.r.color) } : {}} />
                <polygon class={cx("head", arrowClass(a.r.team))} points={arrowHead(f(), t(), 22)} style={a.r.color != null ? { fill: colorOf(a.r.color) } : {}} />
                <Show when={editor() && p.tool === "select"}>
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
              <path class={cx("arw", arrowClass(a().team))} d={polyline([a().from, shaftEnd(a().from, a().to, 10)])} style={{ stroke: colorOf(p.ink) }} />
              <polygon class={cx("head", arrowClass(a().team))} points={arrowHead(a().from, a().to, 22)} style={{ fill: colorOf(p.ink) }} />
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
      <Tokens
        editing={p.editing}
        state={st}
        art={p.art}
        vp={p.vp}
        scene={p.tokenScene ?? p.scene}
        tool={p.tool}
        k={p.k}
        svg={p.svg}
        selection={p.selection}
        setSelection={p.setSelection}
        onPress={clearObjects}
        frame={p.frame}
        focused={p.focused}
        onOpen={p.onOpenHero}
        trackedHero={p.trackedHero}
        onTrackHero={p.onTrackHero}
        isCardOpen={p.isCardOpen}
        onCloseCard={p.onCloseCard}
        onDragHero={p.onDragHero}
        bindTap={(f) => (tokenTap = f)}
      />
      <For each={othersPicks()}>
        {(x) => (
          <g class="picks" data-picks={x.peer.state!.name} style={{ "pointer-events": "none" }}>
            <For each={x.at}>{(q) => <circle class="pick-ring" cx={q.x} cy={q.y} r={q.r} style={{ "--c": colorOf(x.peer.state!.color) }} />}</For>
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
            // A palette colour, if it has one: the bubble, pin and card take it, and their marks
            // and text take whichever of dark or light reads on it.
            const tint = () => (c.r.color != null ? { "--comment": colorOf(c.r.color), "--comment-ink": inkOn(colorOf(c.r.color)) } : {});
            if (p.compactCallouts)
              return (
                <g class={cx("co-pin", c.r.color != null && "tinted")} data-callout={c.id} style={tint()} transform={`translate(${pos().x} ${pos().y}) scale(${p.k})`}>
                  <circle r="16" />
                  <text>{callouts().findIndex((x) => x.id === c.id) + 1}</text>
                </g>
              );
            const sc = () => p.unitsPerPx();
            const box = () => cardBox(c.r.text, pos(), sc(), p.visible(), c.r.side);
            const shape = () => bubble(c.r.side);
            const drawn = () => (
              <>
                <path class="bubble-body" d={shape().body} />
                <path class="bubble-dots" d={shape().dots} />
              </>
            );
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
                    class={cx("co", "bubble", c.r.color != null && "tinted", erasing().has(c.id) && "erasing", others().length > 0 && "touched")}
                    style={tint()}
                    data-erase={c.id}
                    data-callout={c.id}
                    data-side={sided(c.r.side)}
                    data-open="false"
                    onPointerDown={(e) => calloutDown(c, e)}
                  >
                    <g transform={`translate(${pos().x} ${pos().y}) scale(${sc() * 0.8})`}>
                      {/* Above draws as every comment did before sides: no group, no mirror. */}
                      <Show when={shape().transform} fallback={drawn()}>
                        {(t) => <g transform={t()}>{drawn()}</g>}
                      </Show>
                    </g>
                    <g class="preview" data-testid="comment-preview">
                      {card("preview-card")}
                    </g>
                    {tags()}
                  </g>
                }
              >
                <g
                  class={cx("co", "open", c.r.color != null && "tinted", erasing().has(c.id) && "erasing", others().length > 0 && "touched")}
                  data-erase={c.id}
                  data-callout={c.id}
                  data-side={sided(c.r.side)}
                  data-open="true"
                  style={{ ...tint(), opacity: hidden() ? 0.25 : undefined }}
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
            // Placed like a card with room for a full-width line, on the comment's side.
            const side = () => callouts().find((c) => c.id === ed().id)?.r.side;
            const box = () => cardBox("x".repeat(26), pos(), sc(), p.visible(), side());
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
            const halves = () => {
              const e = p.laneEdges?.(l.key);
              return e ? splitEdges(l.line, e.amber, e.sapphire, LANE_GAP) : splitAt(l.line, p.splitOf(l.key), LANE_GAP);
            };
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
                <Show when={editor() && canEditEntities() && p.tool === "select"}>
                  <circle
                    class={cx("wave-hit", raised() && "active")}
                    data-testid={`wave-gap-${l.key}`}
                    cx={at().x}
                    cy={at().y}
                    r={14 * p.k}
                    onPointerDown={(e) => e.button === 0 && !p.spaceHeld() && dragWave(e, l.key, Math.round(p.splitOf(l.key)))}
                    aria-label="Wave"
                    ref={() => {
                      onCleanup(registerHover("marker", `wave:${l.key}`, () => ({ x: at().x, y: at().y, gap: 20 * p.k, text: "Wave" })));
                      // Gone with the tool switched (a key, no pointerleave): unhovered.
                      onCleanup(() => hoveredHandle()?.id === `wave:${l.key}` && hoverHandle(undefined));
                    }}
                    onPointerEnter={() => hoverHandle({ kind: "marker", id: `wave:${l.key}` })}
                    onPointerLeave={() => hoverHandle(undefined)}
                  />
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
          {(peer) => {
            // Presence has no times: each point ages from when this browser first saw it.
            const timed = createMemo<{ p: WorldPos; t: number }[]>((prev) => stampLaser(prev, peer.state?.laser ?? [], performance.now()), []);
            const runs = createMemo(() => laserRuns(timed(), peer.state?.laser_starts ?? []));
            return (
              <Index each={runs()}>
                {(run, i) => <LaserTrail points={run().map((q) => ({ p: view(q.p), t: q.t }))} now={laserNow()} color={colorOf(peer.state!.laser_color ?? peer.state!.color)} name={peer.state!.name} head={i === runs().length - 1} k={p.k} />}
              </Index>
            );
          }}
        </For>
        <Index each={myLaser()}>{(run, i) => <LaserTrail points={run()} now={laserNow()} color={colorOf(p.ink)} mine head={i === myLaser().length - 1} k={p.k} />}</Index>
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
      <Show when={p.dragObjHealth?.()}>
        {(d) => {
          const mk = () => p.art.model.markers.find((x) => x.key === d().key);
          return (
            <Show when={mk()}>
              {(m) => {
                const at = () => mapToView(m().at, p.vp);
                const r = () => 22 * p.k;
                const color = () => (m().kind === "midboss" ? "#d9b24a" : washFor(m(), p.vp));
                return (
                  <g class="obj-hp-dial" data-testid="obj-hp-dial" data-key={m().key} data-pct={d().pct} style={{ "--c": color() }}>
                    <circle class="obj-hp-dial-bg" cx={at().x} cy={at().y} r={r()} />
                    <Show when={d().pct > 0}>
                      <circle
                        class="obj-hp-dial-arc"
                        cx={at().x}
                        cy={at().y}
                        r={r()}
                        pathLength={100}
                        stroke-dasharray={`${d().pct} 100`}
                        transform={`rotate(-90 ${at().x} ${at().y})`}
                      />
                    </Show>
                  </g>
                );
              }}
            </Show>
          );
        }}
      </Show>
      <Cursors peers={st.peerList()} scene={p.scene} vp={p.vp} k={p.k} />
      <Show when={menu()} keyed>
        {menuView}
      </Show>
      <Show when={doorMenu()} keyed>
        {doorMenuView}
      </Show>
      <Show when={objMenu()} keyed>
        {objMenuView}
      </Show>
      <Show when={mapMenu()} keyed>
        {mapMenuView}
      </Show>
    </>
  );
}

const samePt = (a: Pt, b: Pt) => a.x === b.x && a.y === b.y;

/** A trail segment, kept across updates by its older point: a point dropping off the tail shifts no
 * index here, so the segment keeps its DOM and its `clipPath` (an SVG resource: rewriting its
 * polygon invalidates the path that references it). */
type LaserSeg = {
  /** Its clipPath's id, fixed for the segment's life. */
  id: string;
  /** The older end: a segment never moves once the point after it is there. */
  a: Pt;
  t: number;
  /** The newer end: the head follows the pointer, so this one is a signal. */
  b: Signal<Pt>;
  /** Its cut polygon, a signal by value: only a changed cut is written. */
  clip: Signal<string>;
};

/** One gesture's trail; the head dot only on the newest (`head`). */
/** `k` is the view's zoom factor (as arrows and name tags use): the trail keeps its size on screen
 * however far the map is zoomed (operator, 2026-11-08: it grew huge zoomed in). */
function LaserTrail(p: { points: Timed[]; now: number; color: string; name?: string; mine?: boolean; head?: boolean; k: number }) {
  const uid = createUniqueId();
  let nextId = 0;
  // The trail's positions, mapped once per change, not once per segment per change.
  const pts = createMemo(() => p.points.map((q) => q.p));
  // Each segment by its older end's age (#42): the tail fades on the clock, not by its place.
  //
  // The trail only drops points at its front and appends at its back, so a dropped point shifts no
  // index: the segments are re-matched by their older point and rendered with `For`, which keeps
  // their DOM. A cut uses points i-1 .. i+2 only, so a new point changes the last segment's cut
  // and a dropped tail point the first's: one or two writes per point, not one per segment
  // (TD-53: a dynamic attribute is written on every run, so a memo is what keeps it quiet).
  const segs = createMemo<LaserSeg[]>((prev) => {
    const all = pts();
    const points = p.points;
    const n = all.length - 1;
    if (n <= 0) return [];
    const first = points[0];
    const from = prev.length && first ? prev.findIndex((s) => s.t === first.t && samePt(s.a, first.p)) : -1;
    const out: LaserSeg[] = [];
    for (let i = 0; i < n; i++) {
      const a = all[i]!, b = all[i + 1]!;
      const old = from >= 0 ? prev[from + i] : undefined;
      const kept = old && old.t === points[i]!.t && samePt(old.a, a) ? old : undefined;
      if (kept) kept.b[1](b);
      const seg = kept ?? { id: `${uid}-${++nextId}`, a, t: points[i]!.t, b: createSignal(b, { equals: samePt }), clip: createSignal("") };
      seg.clip[1](laserClip(all, i));
      out.push(seg);
    }
    return out;
  }, []);
  const head = () => p.points[p.points.length - 1];
  return (
    <g class="laser" style={{ "--c": p.color, "--k": String(p.k) }} data-laser={p.mine ? "mine" : (p.name ?? "")}>
      <For each={segs()}>
        {(s) => {
          const alpha = () => laserAlpha(p.now - s.t);
          return (
            <>
              {/* Each segment cut at its joints (#46): abutting caps, so the fade never doubles. */}
              <clipPath id={s.id} clipPathUnits="userSpaceOnUse">
                <polygon points={s.clip[0]()} />
              </clipPath>
              <path
                d={`M${s.a.x} ${s.a.y} L${s.b[0]().x} ${s.b[0]().y}`}
                clip-path={`url(#${s.id})`}
                style={{ opacity: alpha().toFixed(3), "stroke-width": `${(5 + 4 * alpha()) * p.k}px` }}
              />
            </>
          );
        }}
      </For>
      <Show when={p.head !== false && head()}>{(h) => <circle class="head" cx={h().p.x} cy={h().p.y} r={7 * p.k} style={{ opacity: laserAlpha(p.now - h().t).toFixed(3), "stroke-width": `${4 * p.k}` }} />}</Show>
    </g>
  );
}

export { LASER_MAX_POINTS };

/** Callouts in a stable order (by id), so the phone's numbered pins match its list. */
export function calloutOrder<T extends { id: RecordId }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => (a.id < b.id ? -1 : 1));
}
