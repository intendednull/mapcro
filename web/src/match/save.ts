// "Save as scene" from a match moment: one transaction that adds a frozen scene after the
// current one (players, souls and objectives as at t; clock = t; from a replay also ult
// cooldowns, the rift that's up, taken powerups and lane-wave splits) and, if the board's
// heroes differ from the match's, sets the roster to the match's heroes, slot by slot.
// The scene is also a snapshot of the frame (docs/specs/map-state.md): each hero's record holds
// its build (mapstate/build.ts) and the scene's state says so, in the same transaction. Retake
// gives an older scene the same, from its own moment of the open match.
//
// Phase 5 (docs/specs/map-state-phase5-plan.md): Group A (rows 16–26) and Group B (rows 27–39)
// capture and Retake live here behind `written` (`WRITTEN = 16` in R1, dormant until R2/R3 flip
// rows Live; tested with synthetic `written = 27` and `written = 40`).

import { keyBetween } from "../core/order";
import type { Op } from "../gen/Op";
import type { RecordId } from "../gen/RecordId";
import type { MoreValue } from "../gen/MoreValue";
import type { PlayerState } from "../gen/PlayerState";
import { ROWS, type RowKey } from "../gen/rows";
import type { Marker } from "../map/model";
import type { Slot } from "../board/state";
import type { SceneRow } from "../board/scenes";
import { clampToMap } from "../map/transform";
import { type RiftAt, type Timeline, clockLabel, riftAt, slotKey } from "./timeline";
import { LIMITS } from "../gen/limits";
import type { More } from "../gen/More";
import {
  BUILD_KEYS, type CapturedSnapshot, type SceneCapture, WRITTEN,
  captureBuild, captureScene, captured, heroBuildAt, holdsHealth, moreBytes, retakeRows, writesHeroes,
} from "../mapstate/build";
import {
  encodeCC, encodeCamps, encodeEdges, encodeObjHealth, encodePowerups, encodeRejuv, encodeRift, encodeSkulls, encodeUrn,
  isCampKind,
} from "../mapstate/codec";
import { type FrameMarkers, type SecondPart, savedPart, secondPart, tenthPart } from "../mapstate/frame";
import { type Feature, featuresOf, urnOf } from "../mapstate/state";
import { deathSeen, skullsAt } from "../player/skulls";
import type { Player } from "../board/state";

export { slotKey };

/** Roster slots whose hero differs from the match's (the "Roster → match heroes" change). */
export function rosterChanges(roster: Slot[], tl: Timeline): Array<{ id: RecordId; hero: number }> {
  const byKey = new Map(tl.players.map((p) => [slotKey(p.team, p.slot), p.hero_id]));
  return roster.flatMap((s) => {
    const hero = byKey.get(slotKey(s.slot.team, s.slot.slot));
    return hero !== undefined && s.slot.hero !== hero ? [{ id: s.id, hero }] : [];
  });
}

/** The longest respawn time a hero record holds, in seconds (the schema's bound on `PlayerRespawn`). */
export const MAX_RESPAWN = 600;

/** Phase 5 features: one unified table mapping each feature to its highest row index, its flag
 * on `CapturedSnapshot`, and its `featuresOf(tl)` predicate (plan §6). Shared by Save, `canRetake`,
 * and `retakeOps`. */
export type Phase5Feature =
  | "sight"
  | "cc"
  | "movement"
  | "lanes"
  | "skulls"
  | "camps"
  | "powerups"
  | "obj_health"
  | "rifts"
  | "urn"
  | "rejuv";

export const PHASE5_FEATURES: ReadonlyArray<{
  feature: Phase5Feature;
  firstRow: RowKey;
  lastRow: RowKey;
  flag: keyof CapturedSnapshot;
  hasIn: (f: Record<Feature, boolean>) => boolean;
}> = [
  { feature: "sight", firstRow: "has_sight", lastRow: "unseen", flag: "sight", hasIn: (f) => f.sight },
  { feature: "cc", firstRow: "has_cc", lastRow: "cc", flag: "cc", hasIn: (f) => f.cc },
  { feature: "movement", firstRow: "has_movement", lastRow: "zipline", flag: "movement", hasIn: (f) => f.movement },
  { feature: "lanes", firstRow: "has_lanes", lastRow: "edges", flag: "lanes", hasIn: (f) => f.lanes },
  { feature: "skulls", firstRow: "has_skulls", lastRow: "skulls", flag: "skulls", hasIn: (f) => f.skulls },
  { feature: "camps", firstRow: "has_camps", lastRow: "camps", flag: "camps", hasIn: (f) => f.camps },
  { feature: "powerups", firstRow: "has_powerups", lastRow: "powerups", flag: "powerups", hasIn: (f) => f.powerups },
  { feature: "obj_health", firstRow: "has_obj_health", lastRow: "obj_health", flag: "obj_health", hasIn: (f) => f.obj_health },
  { feature: "rifts", firstRow: "has_rifts", lastRow: "rift", flag: "rifts", hasIn: (f) => f.rifts },
  { feature: "urn", firstRow: "has_urn", lastRow: "urn_at", flag: "urn", hasIn: (f) => f.urn },
  { feature: "rejuv", firstRow: "has_rejuv", lastRow: "rejuv", flag: "rejuv", hasIn: (f) => f.rejuv },
];

/** Feature drop order when a save exceeds `max_tx_bytes - TX_SLACK`, before trimming `build_order`
 * (plan §3). `camps` is never dropped (the baseline is smaller than the records it replaces). */
export const DROP_ORDER: readonly Phase5Feature[] = [
  "skulls",
  "movement",
  "cc",
  "rejuv",
  "urn",
  "rifts",
  "powerups",
  "obj_health",
  "lanes",
  "sight",
];

interface CapturedFrameData {
  sec: SecondPart;
  available: Set<Phase5Feature>;
  heroSight: Map<string, More>;
  heroCc: Map<string, More>;
  heroMovement: Map<string, More>;
  laneEdges: Map<string, number[]>;
  skullsData: number[];
  campsData: number[];
  skippedCamps: Set<string>;
  powerupsData: number[];
  skippedPowerups: Set<string>;
  objHealthData: number[];
  riftData: number[];
  urnData: number[];
  urnAt?: { x: number; y: number };
  rejuvData: number[];
}

function captureFrameData(tl: Timeline, second: number, markers: FrameMarkers, written: number): CapturedFrameData {
  const feat = featuresOf(tl);
  const sec = secondPart(tl, second, markers);
  const needsTenth = (feat.sight && ROWS.unseen.index < written) || (feat.cc && ROWS.cc.index < written);
  const ten = needsTenth ? tenthPart(tl, second) : undefined;
  const available = new Set<Phase5Feature>();
  const heroSight = new Map<string, More>();
  const heroCc = new Map<string, More>();
  const heroMovement = new Map<string, More>();
  const laneEdges = new Map<string, number[]>();

  if (feat.sight && ROWS.unseen.index < written) {
    available.add("sight");
    tl.players.forEach((p, i) => {
      if (ten!.sight[i] !== true) heroSight.set(slotKey(p.team, p.slot), { unseen: true });
    });
  }
  if (feat.cc && ROWS.cc.index < written) {
    available.add("cc");
    tl.players.forEach((p, i) => {
      const code = encodeCC(ten!.cc[i]);
      if (code !== undefined) heroCc.set(slotKey(p.team, p.slot), { cc: code });
    });
  }
  if (feat.movement && ROWS.zipline.index < written) {
    available.add("movement");
    tl.players.forEach((p, i) => {
      const mv = sec.movement[i];
      const m: More = {};
      if (mv?.height === 1 || mv?.height === 2) m.height = mv.height;
      if (mv?.zipline) m.zipline = true;
      if (Object.keys(m).length) heroMovement.set(slotKey(p.team, p.slot), m);
    });
  }
  if (feat.lanes && ROWS.edges.index < written) {
    available.add("lanes");
    for (const [lane, w] of sec.lanes) laneEdges.set(lane, encodeEdges(w));
  }
  let skullsData: number[] = [];
  if (feat.skulls && ROWS.skulls.index < written) {
    available.add("skulls");
    const by = new Map(tl.players.map((p, i) => [slotKey(p.team, p.slot), i]));
    const deaths = skullsAt(tl.players, second, null).map((s) => ({ ...s, seen: deathSeen(tl.players[by.get(s.slot)!]!, s.t) }));
    skullsData = encodeSkulls(deaths, second);
  }

  let campsData: number[] = [];
  let skippedCamps = new Set<string>();
  if (feat.camps && ROWS.camps.index < written && markers.length > 0) {
    const res = encodeCamps(sec.camps, second, markers);
    if (!res.overflow) {
      available.add("camps");
      campsData = res.ints;
      skippedCamps = res.skipped;
    }
  }
  let powerupsData: number[] = [];
  let skippedPowerups = new Set<string>();
  if (feat.powerups && ROWS.powerups.index < written && markers.length > 0) {
    const res = encodePowerups(sec.powerups, second, markers);
    if (!res.overflow) {
      available.add("powerups");
      powerupsData = res.ints;
      skippedPowerups = res.skipped;
    }
  }
  let objHealthData: number[] = [];
  if (feat.obj_health && ROWS.obj_health.index < written && sec.health && markers.length > 0) {
    const res = encodeObjHealth(sec.health, markers);
    if (!res.overflow) {
      available.add("obj_health");
      objHealthData = res.ints;
    }
  }
  let riftData: number[] = [];
  if (feat.rifts && ROWS.rift.index < written && markers.length > 0) {
    const rifts = new Map<string, RiftAt>();
    for (const mk of markers) {
      if (mk.kind !== "koth") continue;
      const r = riftAt(tl, mk.key, second, markers);
      if (r) rifts.set(mk.key, r);
    }
    const res = encodeRift(rifts, second, markers);
    if (!res.collision) {
      available.add("rifts");
      riftData = res.ints;
    }
  }
  let urnData: number[] = [];
  let urnAtPos: { x: number; y: number } | undefined;
  if (feat.urn && ROWS.urn_at.index < written && markers.length > 0) {
    const u = urnOf(tl, second, markers);
    if (u) {
      const res = encodeUrn(u, second, markers);
      if (!res.collision) {
        available.add("urn");
        urnData = res.ints;
        urnAtPos = res.at;
      }
    }
  }
  let rejuvData: number[] = [];
  if (feat.rejuv && ROWS.rejuv.index < written && sec.rejuv) {
    available.add("rejuv");
    rejuvData = encodeRejuv(sec.rejuv, second);
  }

  return {
    sec,
    available,
    heroSight,
    heroCc,
    heroMovement,
    laneEdges,
    skullsData,
    campsData,
    skippedCamps,
    powerupsData,
    skippedPowerups,
    objHealthData,
    riftData,
    urnData,
    ...(urnAtPos ? { urnAt: urnAtPos } : {}),
    rejuvData,
  };
}

function sceneCaptureFrom(fd: CapturedFrameData, active: ReadonlySet<Phase5Feature>): Partial<SceneCapture> {
  return {
    ...(active.has("sight") ? { sight: true } : {}),
    ...(active.has("cc") ? { cc: true } : {}),
    ...(active.has("movement") ? { movement: true } : {}),
    ...(active.has("lanes") ? { lanes: true } : {}),
    ...(active.has("skulls") ? { skulls: true, skullsData: fd.skullsData } : {}),
    ...(active.has("camps") ? { camps: true, campsData: fd.campsData } : {}),
    ...(active.has("powerups") ? { powerups: true, powerupsData: fd.powerupsData } : {}),
    ...(active.has("obj_health") ? { objHealth: true, objHealthData: fd.objHealthData } : {}),
    ...(active.has("rifts") ? { rifts: true, riftData: fd.riftData } : {}),
    ...(active.has("urn") ? { urn: true, urnData: fd.urnData, ...(fd.urnAt ? { urnAt: fd.urnAt } : {}) } : {}),
    ...(active.has("rejuv") ? { rejuv: true, rejuvData: fd.rejuvData } : {}),
  };
}

function heroExtraFrom(fd: CapturedFrameData, active: ReadonlySet<Phase5Feature>, slot: string): More {
  const out: More = {};
  if (active.has("sight")) Object.assign(out, fd.heroSight.get(slot));
  if (active.has("cc")) Object.assign(out, fd.heroCc.get(slot));
  if (active.has("movement")) Object.assign(out, fd.heroMovement.get(slot));
  return out;
}

/** Save as scene from moment `t` of `tl`: the scene and its records, in one transaction's
 * `ops`. Empty `ops`: the scene can't be saved whole (it would not hold its heroes), so nothing
 * is sent. `builds`: the snapshot's builds are in it. */
export function matchSceneOps(
  roster: Slot[],
  scenes: SceneRow[],
  current: SceneRow | undefined,
  tl: Timeline,
  t: number,
  markers: Array<Pick<Marker, "key" | "kind" | "team" | "lane" | "at">>,
  mint: () => RecordId,
  lanes: string[] = [],
  opts: SceneOpts = {},
): { id: RecordId; ops: Op[]; order: string; builds: boolean } {
  const i = current ? scenes.findIndex((s) => s.id === current.id) : scenes.length - 1;
  const id = mint();
  const second = Math.floor(t);
  const order = keyBetween(opts.after ?? scenes[i]?.scene.order, scenes[i + 1]?.scene.order);
  const name = opts.name ?? "Match moment";
  const scene = { name: sceneName(name, second), order, clock: second, ...(opts.source ? { source: { ...opts.source, t: second } } : {}) };
  const sceneAndHeroes: Op[] = [{ Create: { id, record: { Scene: scene } } }];
  const written = opts.written ?? WRITTEN;
  const usePhase5 = opts.builds !== false && written > 16;
  const fd = usePhase5 ? captureFrameData(tl, second, markers, written) : undefined;
  // The frame's facts, unfiltered (map-state spec D9): what Player's second's part is built on
  // (mapstate/frame.ts). At a whole second a hero's place and respawn time are its sample's.
  const frame = fd ? fd.sec : savedPart(tl, second, markers);
  const at = new Map(frame.heroes.map((p) => [slotKey(p.team, p.slot), p]));
  const heroes: Array<{ PlayerState: PlayerState }> = [];
  for (const s of roster) {
    const p = at.get(slotKey(s.slot.team, s.slot.slot));
    const where = p?.pos ?? p?.last;
    const pos = where ? clampToMap({ x: where.x, y: where.y }) : { x: 0, y: 0 };
    // A dead hero keeps its respawn time (map-state spec D4), in whole seconds rounded up, as
    // Player's bar counts it down.
    const respawn = p && p.pos === null && p.respawn != null ? Math.min(MAX_RESPAWN, Math.ceil(p.respawn)) : null;
    const record = { PlayerState: { scene: id, slot: s.id, pos, alive: p ? p.pos !== null : true, placed: !!where, souls: p?.souls ?? null, ult_cooldown: p?.ult ?? null, visible: true, ...(respawn != null ? { respawn } : {}) } as PlayerState };
    heroes.push(record);
    sceneAndHeroes.push({ Create: { id: mint(), record } });
  }
  // A scene has one split per lane: the middle of the zipline colours' gap (spec §6b).
  const waveRecs: Array<{ lane: string; rec: { Wave: { scene: RecordId; lane: string; t: number; more?: More } } }> = [];
  for (const [lane, w] of frame.lanes) {
    if (lanes.length === 0 || lanes.includes(lane)) {
      waveRecs.push({ lane, rec: { Wave: { scene: id, lane, t: Math.round((w.amber + w.sapphire) / 2) } } });
    }
  }
  // A scene that holds its own heroes (spec D2) leaves the board's roster alone: no other
  // scene's heroes change. A build from before `has_heroes` was written set the roster to the
  // match's (`written` below the row: tests of that build pass it).
  const own = writesHeroes(written);
  const rosterOps: Op[] = !own && opts.roster !== false ? rosterChanges(roster, tl).map((c) => ({ Set: { id: c.id, value: { RosterHero: c.hero } } })) : [];

  // Save omission rule (plan §4 Q6):
  // - At `written <= 16` (`!fd`): preserve exact v14 all-or-nothing legacy `ObjectiveState` list (no truncation).
  // - At `written > 16` (`fd`): cover sites using `fd.available` during the `builds: true` / `DROP_ORDER`
  //   pass (plan §3: never replace dropped baseline features with `ObjectiveState`s), and budget any
  //   uncovered optional site fallbacks as whole feature buckets (`urn`, `rifts`, `powerups`, `camps`)
  //   so an overflowing bucket is omitted whole rather than prefix-truncated or crowding out smaller sites.
  type ObjEntry = { key: string; status: "Active" | "Destroyed" };
  type SiteBucket = "urn" | "rifts" | "powerups" | "camps";
  const BUCKET_ORDER: readonly SiteBucket[] = ["urn", "rifts", "powerups", "camps"];
  // Key sites by board marker `kind` (falling back to key prefix only when markers aren't passed),
  // so remapped koth/urn/powerup markers whose resolved keys don't share the timeline prefix still
  // use the right default-off status and overflow bucket.
  const kindByKey = new Map(markers.map((m) => [m.key, m.kind]));
  const bucketOf = (key: string): SiteBucket => {
    const kind = kindByKey.get(key);
    if (kind === "urn" || (!kind && key.startsWith("urn:"))) return "urn";
    if (kind === "koth" || (!kind && key.startsWith("rift:"))) return "rifts";
    if (kind === "powerup" || (!kind && key.startsWith("powerup:"))) return "powerups";
    return "camps";
  };

  const coveredFrom = (avail: ReadonlySet<Phase5Feature>): Set<string> => {
    const covered = new Set<string>();
    if (!fd) return covered;
    for (const mk of markers) {
      if (avail.has("camps") && isCampKind(mk.kind) && fd.sec.camps.has(mk.key) && !fd.skippedCamps.has(mk.key)) covered.add(mk.key);
      if (avail.has("powerups") && mk.kind === "powerup" && fd.sec.powerups.has(mk.key) && !fd.skippedPowerups.has(mk.key)) covered.add(mk.key);
      if (avail.has("rifts") && mk.kind === "koth") covered.add(mk.key);
      if (avail.has("urn") && mk.kind === "urn") covered.add(mk.key);
    }
    return covered;
  };

  const splitObjectives = (covered: ReadonlySet<string>) => {
    const mandatory: ObjEntry[] = [];
    for (const key of frame.down) {
      if (!covered.has(key)) mandatory.push({ key, status: "Destroyed" });
    }
    const optional: Array<ObjEntry & { bucket: SiteBucket }> = [];
    const byBucket: Record<SiteBucket, ObjEntry[]> = { urn: [], rifts: [], powerups: [], camps: [] };
    // Only what differs from a new scene's defaults: the rift that's up and the open urn point
    // (both default off), and taken powerups/camps (they default available).
    for (const [key, status] of frame.sites) {
      if (covered.has(key)) continue;
      const kind = kindByKey.get(key);
      const off = kind === "koth" || kind === "urn" || (!kind && (key.startsWith("rift:") || key.startsWith("urn:")));
      if ((off && status === "Active") || (!off && status === "Destroyed")) {
        const entry = { key, status };
        const bucket = bucketOf(key);
        optional.push({ ...entry, bucket });
        byBucket[bucket].push(entry);
      }
    }
    return { mandatory, optional, byBucket };
  };

  const fitBuckets = (covered: ReadonlySet<string>, maxOps: number, fits?: (objs: ObjEntry[]) => boolean): ObjEntry[] => {
    const { mandatory, optional, byBucket } = splitObjectives(covered);
    const chosen = new Set<SiteBucket>();
    let count = mandatory.length;
    const assemble = () => [...mandatory, ...optional.filter((e) => chosen.has(e.bucket)).map(({ key, status }) => ({ key, status }))];
    for (const b of BUCKET_ORDER) {
      const list = byBucket[b];
      if (!list.length || count + list.length > maxOps) continue;
      chosen.add(b);
      if (fits && !fits(assemble())) {
        chosen.delete(b);
      } else {
        count += list.length;
      }
    }
    return assemble();
  };

  const allLegacyObjs = (): ObjEntry[] => {
    const { mandatory, optional } = splitObjectives(new Set());
    return [...mandatory, ...optional.map(({ key, status }) => ({ key, status }))];
  };

  const fixedCount = sceneAndHeroes.length + waveRecs.length + rosterOps.length;
  const maxObjWithState = Math.max(0, LIMITS.max_ops_per_tx - fixedCount - 1);
  // Placeholder ID for byte sizing before minting: exact length in prod (22 chars), +1 char in tests.
  const probeId = id.length >= 22 ? id : `${id}0`;
  const previewOps = (objs: ObjEntry[], stateMore?: More): Op[] => [
    ...sceneAndHeroes,
    ...objs.map((o): Op => ({ Create: { id: probeId, record: { ObjectiveState: { scene: id, key: o.key, status: o.status } } } })),
    ...waveRecs.map(({ rec }): Op => ({ Create: { id: probeId, record: rec } })),
    ...rosterOps,
    ...(stateMore !== undefined ? [{ Create: { id: probeId, record: { SceneState: { scene: id, more: stateMore } } } } as Op] : []),
  ];

  // The snapshot (map-state spec §4.4): every hero's build, phase 5 features (behind `written`),
  // and the scene's state, if the whole save still fits one transaction; else optional phase 5
  // features drop in DROP_ORDER before trimming `build_order`, and if still too large the scene
  // is saved without builds (Retake can add them later).
  const txBudget = opts.txBudget ?? (LIMITS.max_tx_bytes - TX_SLACK);
  let stored = false;
  const legacyObjs = allLegacyObjs();
  let finalObjs: ObjEntry[] = legacyObjs;
  let finalState: More | undefined;
  if (opts.builds !== false && fixedCount < LIMITS.max_ops_per_tx) {
    const tier = opts.source ? opts.source.tier : null;
    if (!fd) {
      if (fixedCount + legacyObjs.length < LIMITS.max_ops_per_tx) {
        const stateMore = captureScene(tl, { written });
        const room = txBudget - opsBytes(previewOps(legacyObjs, stateMore));
        const builds = sceneBuilds(roster, tl, second, room, tier);
        if (builds) {
          roster.forEach((s, idx) => {
            const more = builds.get(s.id);
            if (more) heroes[idx]!.PlayerState.more = more;
          });
          finalObjs = legacyObjs;
          finalState = stateMore;
          stored = true;
        }
      }
    } else {
      // Coverage stays fixed to `fd.available` across `DROP_ORDER` (plan §3: never replace dropped
      // baseline features with `ObjectiveState`s).
      const objs = fitBuckets(coveredFrom(fd.available), maxObjWithState);
      if (fixedCount + objs.length < LIMITS.max_ops_per_tx) {
        const active = new Set(fd.available);
        const syncWaves = () => {
          for (const { lane, rec } of waveRecs) {
            const e = active.has("lanes") ? fd.laneEdges.get(lane) : undefined;
            if (e) rec.Wave.more = { edges: e };
            else delete rec.Wave.more;
          }
        };
        const tryFit = (allowTrim: boolean): { builds: Map<RecordId, More>; stateMore: More } | undefined => {
          syncWaves();
          const stateMore = captureScene(tl, { written, ...sceneCaptureFrom(fd, active) });
          const room = txBudget - opsBytes(previewOps(objs, stateMore));
          const builds = sceneBuilds(roster, tl, second, room, tier, (slot) => heroExtraFrom(fd, active, slot), allowTrim);
          return builds ? { builds, stateMore } : undefined;
        };
        let fitted = tryFit(false);
        if (!fitted) {
          for (const drop of DROP_ORDER) {
            if (!active.has(drop)) continue;
            active.delete(drop);
            fitted = tryFit(false);
            if (fitted) break;
          }
        }
        if (!fitted) fitted = tryFit(true);
        if (fitted) {
          roster.forEach((s, idx) => {
            const more = fitted!.builds.get(s.id);
            if (more) heroes[idx]!.PlayerState.more = more;
          });
          finalObjs = objs;
          finalState = fitted.stateMore;
          stored = true;
        } else {
          for (const { rec } of waveRecs) delete rec.Wave.more;
        }
      }
    }
  }
  // Without the builds the scene still holds its heroes: each record its match's hero, and a
  // state that says so. Both or neither, to the byte.
  // - At `written <= 16`: exact v14 all-or-nothing check against `legacyObjs`.
  // - At `written > 16`: preserve legacy site buckets as whole units regardless of `opts.builds`,
  //   dropping overflowing optional site buckets by ops or bytes so the mandatory heroes-only scene
  //   still saves (Astra R1 review edge).
  let held = !own || stored;
  if (!stored && own && fixedCount < LIMITS.max_ops_per_tx) {
    const players = new Map(tl.players.map((p) => [slotKey(p.team, p.slot), p]));
    const mine = roster.map((s) => players.get(slotKey(s.slot.team, s.slot.slot))?.hero_id);
    const stateMore = captureScene(tl, { builds: false, written });
    const bytes = mine.reduce((n: number, hero) => n + (hero == null ? 0 : MORE_KEY + moreBytes({ hero })), 0);
    const fitsBytes = (objs: ObjEntry[]) => opsBytes(previewOps(objs, stateMore)) + bytes <= txBudget;
    const fallbackObjs = written > 16 ? fitBuckets(new Set(), maxObjWithState, fitsBytes) : legacyObjs;
    if (fixedCount + fallbackObjs.length < LIMITS.max_ops_per_tx && fitsBytes(fallbackObjs)) {
      mine.forEach((hero, idx) => {
        if (hero != null) heroes[idx]!.PlayerState.more = { hero };
      });
      finalObjs = fallbackObjs;
      finalState = stateMore;
      held = true;
    }
  }
  // No room even for that (the save's own records fill the transaction; not seen on a real
  // match): no scene at all, rather than one that draws the board roster's heroes, which Save
  // no longer sets. `ops` is then empty and the caller says "Not saved".
  if (!held) return { id, ops: [], order, builds: false };
  // Assemble in canonical order (Scene, PlayerStates, ObjectiveStates, Waves, RosterHero, SceneState).
  const ops: Op[] = [
    ...sceneAndHeroes,
    ...finalObjs.map((o): Op => ({ Create: { id: mint(), record: { ObjectiveState: { scene: id, key: o.key, status: o.status } } } })),
    ...waveRecs.map(({ rec }): Op => ({ Create: { id: mint(), record: rec } })),
    ...rosterOps,
    ...(finalState !== undefined ? [{ Create: { id: mint(), record: { SceneState: { scene: id, more: finalState } } } } as Op] : []),
  ];
  return { id, ops, order, builds: stored };
}

/** Bytes kept free in a transaction for what wraps its ops on the wire (the client's id, the
 * cseq and kind) and for each `more` key's own punctuation. */
const TX_SLACK = 1024;
/** Ops as the server counts a transaction against `max_tx_bytes`: their JSON, in bytes. */
export const opsBytes = (ops: Op[]) => new TextEncoder().encode(JSON.stringify(ops)).length;

/**
 * Each roster slot's build (plus any optional Group A hero rows) at `second` of the match, as its
 * hero record's `more`, all within `room` bytes together (each within a record's own cap): when
 * `allowTrim` is true, the build orders lose their oldest rows to fit. `undefined`: they don't fit.
 */
function sceneBuilds(
  roster: Slot[],
  tl: Timeline,
  second: number,
  room: number,
  tier: string | null,
  extraOf?: (slot: string) => More,
  allowTrim = true,
): Map<RecordId, More> | undefined {
  const players = new Map(tl.players.map((p) => [slotKey(p.team, p.slot), p]));
  const mine = roster.flatMap((s) => {
    const key = slotKey(s.slot.team, s.slot.slot);
    const p = players.get(key);
    return p ? [{ id: s.id, key, build: heroBuildAt(tl, p, second, tier) }] : [];
  });
  const out = new Map<RecordId, More>();
  const shares = allowTrim ? [LIMITS.max_more_bytes, Math.floor(room / Math.max(1, mine.length))] : [LIMITS.max_more_bytes];
  for (const share of shares) {
    out.clear();
    let bytes = 0;
    let ok = true;
    for (const m of mine) {
      const extra = extraOf?.(m.key);
      const extraBytes = extra && Object.keys(extra).length ? moreBytes(extra) : 0;
      const buildBudget = Math.max(0, Math.min(share, LIMITS.max_more_bytes) - extraBytes);
      const more = extra && extraBytes ? { ...captureBuild(m.build, buildBudget), ...extra } : captureBuild(m.build, buildBudget);
      const len = moreBytes(more);
      if (len > LIMITS.max_more_bytes) {
        ok = false;
        break;
      }
      bytes += len + MORE_KEY;
      out.set(m.id, more);
    }
    if (ok && bytes <= room) return out;
  }
  return undefined;
}
/** `,"more":` on a record. */
const MORE_KEY = 8;

/** Plan missing build backfill ops per eligible hero, checking `LIMITS.max_more_bytes`.
 * `buildComplete` is `false` iff any eligible hero had a missing build key (after `captureBuild`
 * trims `build_order`) or missing `hero` id that could not fit under `max_more_bytes`; that jammed
 * hero emits no partial build ops so its headroom stays intact and Retake stays retryable. */
function planRetakeBuilds(
  tl: Timeline,
  second: number,
  tier: string | null,
  own: boolean,
  heroes: Player[],
  roster: Slot[],
  fd: CapturedFrameData | undefined,
  missingFeatures: ReadonlySet<Phase5Feature>,
  written: number,
): { buildGroups: Op[][]; buildComplete: boolean; projectedHero: Map<RecordId, More> } {
  const players = new Map(tl.players.map((p) => [slotKey(p.team, p.slot), p]));
  const slots = new Map(roster.map((s) => [s.id, s]));
  const absent = (id: RecordId, key: string, value: MoreValue): Op => ({ SetIf: { id, expect: { More: { key, value: null } }, value: { More: { key, value } } } });
  const buildGroups: Op[][] = [];
  const projectedHero = new Map<RecordId, More>();
  for (const h of heroes) projectedHero.set(h.id, { ...(h.state.more ?? {}) });
  const buildSet = new Set<string>(["hero", ...BUILD_KEYS]);
  let buildComplete = true;

  for (const h of heroes) {
    const s = slots.get(h.state.slot);
    const key = s && slotKey(s.slot.team, s.slot.slot);
    const p = key ? players.get(key) : undefined;
    if (!p || !key) continue;
    const have = h.state.more ?? {};
    // A slot given another hero in a scene that holds its heroes: the match's build is not
    // that hero's, and stays out.
    if (typeof have.hero === "number" && have.hero !== p.hero_id) continue;
    // Reserve space for existing non-build keys (e.g. `name`) and any missing Group A hero keys
    // so a late-game build backfill trims `build_order` instead of starving sight/CC/movement.
    const reserve: More = {};
    for (const [k, v] of Object.entries(have)) {
      if (!buildSet.has(k)) reserve[k] = v;
    }
    if (fd && missingFeatures.size > 0) {
      for (const [k, v] of Object.entries(heroExtraFrom(fd, missingFeatures, key))) {
        if (have[k] === undefined && ROWS[k as RowKey].index < written) reserve[k] = v;
      }
    }
    const reserveBytes = Object.keys(reserve).length ? moreBytes(reserve) : 0;
    const buildBudget = Math.max(0, LIMITS.max_more_bytes - reserveBytes);
    const candidateProj: More = { ...have };
    const ops: Op[] = [];
    let heroFits = true;
    for (const [bk, bv] of Object.entries(captureBuild(heroBuildAt(tl, p, second, tier), buildBudget))) {
      if (have[bk] !== undefined || (own && bk === "hero")) continue;
      if (moreBytes({ ...candidateProj, [bk]: bv }) > LIMITS.max_more_bytes) {
        heroFits = false;
        break;
      }
      candidateProj[bk] = bv;
      ops.push(absent(h.id, bk, bv));
    }
    if (heroFits && own && (ops.length || have.hero === undefined)) {
      if (have.hero === undefined && moreBytes({ ...candidateProj, hero: p.hero_id }) > LIMITS.max_more_bytes) {
        heroFits = false;
      } else {
        candidateProj.hero = p.hero_id;
        const held = BUILD_KEYS.filter((bk) => have[bk] !== undefined).map((bk) => absent(h.id, bk, have[bk]!));
        ops.unshift({ Set: { id: h.id, value: { More: { key: "hero", value: p.hero_id } } } }, ...held);
      }
    }
    if (!heroFits) {
      buildComplete = false;
      continue;
    }
    projectedHero.set(h.id, candidateProj);
    if (ops.length) buildGroups.push(ops);
  }
  return { buildGroups, buildComplete, projectedHero };
}

/** Whether Retake has anything to give a scene: it came from `tl`'s match, and holds no build
 * snapshot, or lacks features that `tl` supplies, this build writes (`written`), and (when
 * records are supplied) fit under `max_more_bytes`. Never offers a no-op Retake (TD-161, plan §6). */
export function canRetake(
  scene: Pick<SceneRow["scene"], "source">,
  state: More | undefined,
  tl: Pick<Timeline, "match_id" | "tier" | "players" | "zips" | "camps" | "heals" | "crates" | "powerups" | "objective_health" | "rifts" | "urn" | "rejuv"> | undefined,
  written: number = WRITTEN,
  markers?: FrameMarkers,
  heroes?: Player[],
  roster?: Slot[],
  waves?: ReadonlyMap<string, { id: RecordId; t: number; more?: More }>,
): boolean {
  if (!tl || scene.source?.match_id !== tl.match_id || !retakesFrom(scene.source.tier, tl)) return false;
  const c = captured(state);
  if (written <= 16) return !c.builds || c.rows < retakeRows(written);
  const full = tl as Timeline;
  const feat = featuresOf(full);
  const missing = PHASE5_FEATURES.filter((f) => ROWS[f.lastRow].index < written && !c[f.flag] && f.hasIn(feat));
  const needsBuilds = !c.builds || c.rows < 15;
  if (!needsBuilds && !missing.length) return false;
  if (heroes && roster && scene.source?.t != null) {
    const second = scene.source.t;
    const tier = scene.source.tier ?? null;
    const fd = captureFrameData(full, Math.floor(second), markers ?? [], written);
    const missingSet = new Set(missing.filter((f) => fd.available.has(f.feature)).map((f) => f.feature));
    const { buildGroups, buildComplete, projectedHero } = planRetakeBuilds(full, second, tier, c.heroes, heroes, roster, fd, missingSet, written);
    // When `c.rows < 15`, advancing past row 14 would falsely claim rows 11–14 are captured;
    // gate Phase 5 features behind `buildComplete` so `rows` never crosses 14 with missing build keys.
    if (c.rows < 15 && !buildComplete) return buildGroups.length > 0;
    if (needsBuilds && (buildGroups.length > 0 || buildComplete)) return true;
    if (!missingSet.size) return false;
    const { admitted } = preflightRetakeFeatures(full, state, heroes, roster, fd, missingSet, written, waves, projectedHero, buildComplete);
    return admitted.size > 0;
  }
  if (needsBuilds) return true;
  // If any Group A feature or `rejuv` is missing, it always fits (no list cap / hash collision).
  const simple = missing.some((f) => f.feature === "sight" || f.feature === "cc" || f.feature === "movement" || f.feature === "lanes" || f.feature === "skulls" || f.feature === "rejuv");
  if (simple) return true;
  if (!markers?.length || scene.source?.t == null) return false;
  // For list-capped / hash-checked Group B features, verify at least one actually fits at `source.t`.
  const fd = captureFrameData(full, Math.floor(scene.source.t), markers, written);
  return missing.some((f) => fd.available.has(f.feature));
}

/** Preflight each missing Phase 5 feature against `LIMITS.max_more_bytes` on every touched hero,
 * wave, and `SceneState` record (using projected `more` maps after any earlier writes in the same
 * Retake). Combined with `Op::Set` in `sceneGroup` (so a concurrent peer eating space aborts the
 * whole transaction atomically on the server), incomplete data is never marked captured. */
function preflightRetakeFeatures(
  tl: Timeline,
  stateMore: More | undefined,
  heroes: Player[],
  roster: Slot[],
  fd: CapturedFrameData,
  missingFeatures: ReadonlySet<Phase5Feature>,
  written: number,
  waves?: ReadonlyMap<string, { id: RecordId; t: number; more?: More }>,
  projectedHeroes?: Map<RecordId, More>,
  buildComplete = true,
): { admitted: Set<Phase5Feature>; skipped: Array<(typeof PHASE5_FEATURES)[number]> } {
  const players = new Map(tl.players.map((p) => [slotKey(p.team, p.slot), p]));
  const slots = new Map(roster.map((s) => [s.id, s]));
  const heroMore = new Map<RecordId, More>();
  for (const h of heroes) heroMore.set(h.id, { ...(projectedHeroes?.get(h.id) ?? h.state.more ?? {}) });
  const baseState = captureScene(tl, { builds: buildComplete, heroes: false, written });
  const stateProj: More = { ...(stateMore ?? {}) };
  if (buildComplete && stateProj.has_builds !== true) stateProj.has_builds = true;
  if (baseState.build !== undefined && stateProj.build === undefined) stateProj.build = baseState.build;
  const admitted = new Set<Phase5Feature>();
  const skipped: Array<(typeof PHASE5_FEATURES)[number]> = [];

  for (const entry of PHASE5_FEATURES) {
    const f = entry.feature;
    if (!missingFeatures.has(f)) continue;
    let fits = true;
    const heroDeltas: Array<{ id: RecordId; add: More }> = [];
    if (f === "sight" || f === "cc" || f === "movement") {
      const single = new Set<Phase5Feature>([f]);
      for (const h of heroes) {
        const s = slots.get(h.state.slot);
        if (!s) continue;
        const key = slotKey(s.slot.team, s.slot.slot);
        if (!players.has(key)) continue;
        const cur = heroMore.get(h.id) ?? {};
        const extra = heroExtraFrom(fd, single, key);
        const add: More = {};
        for (const [k, v] of Object.entries(extra)) {
          if (cur[k] === undefined && ROWS[k as RowKey].index < written) add[k] = v;
        }
        if (Object.keys(add).length) {
          if (moreBytes({ ...cur, ...add }) > LIMITS.max_more_bytes) {
            fits = false;
            break;
          }
          heroDeltas.push({ id: h.id, add });
        }
      }
    } else if (f === "lanes" && waves) {
      for (const [lane] of fd.sec.lanes) {
        const edges = fd.laneEdges.get(lane);
        const existing = edges ? waves.get(lane) : undefined;
        if (edges && existing && existing.more?.edges === undefined) {
          if (moreBytes({ ...(existing.more ?? {}), edges }) > LIMITS.max_more_bytes) {
            fits = false;
            break;
          }
        }
      }
    }

    const stateCap = captureScene(tl, { builds: buildComplete, heroes: false, written, ...sceneCaptureFrom(fd, new Set<Phase5Feature>([f])) });
    const stateAdd: More = {};
    for (const [k, v] of Object.entries(stateCap)) {
      if (k === "rows" || k === "has_builds" || k === "build" || k === "has_heroes") continue;
      if (JSON.stringify(stateProj[k]) !== JSON.stringify(v)) stateAdd[k] = v;
    }
    if (fits && moreBytes({ ...stateProj, ...stateAdd, rows: written }) > LIMITS.max_more_bytes) {
      fits = false;
    }

    if (fits) {
      admitted.add(f);
      for (const { id, add } of heroDeltas) Object.assign(heroMore.get(id)!, add);
      Object.assign(stateProj, stateAdd);
    } else {
      skipped.push(entry);
    }
  }
  return { admitted, skipped };
}

/**
 * Retake (map-state spec §2 D10, §4.4; plan §6): what a scene saved from this match didn't
 * capture, from its own moment (`source.t`) of the open match.
 *
 * Per-hero build backfills use `SetIf` on absent (preserving TD-119 / manual build edits).
 * All Phase 5 ops (Group A hero `unseen`/`cc`/`height`/`zipline`, lane `edges`, and `SceneState`
 * flags, payloads, dormant flag clears, and watermark bump) go in ONE indivisible `sceneGroup`
 * transaction using `Op::Set`, emitted last: on the server, `Op::Set` invokes `check_more_fits?`
 * and aborts the entire transaction atomically on `TxTooLarge` if a concurrent peer consumed the
 * remaining bytes under `max_more_bytes`.
 *
 * Re-picked slot rule (plan §6): build rows are skipped for a re-picked slot; Group A hero rows
 * are slot-at-the-frame facts and are filled for every matched slot (re-picked or not) without
 * triggering `Set hero`.
 */
export function retakeOps(
  scene: SceneRow,
  state: { id: RecordId; more: More | undefined } | undefined,
  heroes: Player[],
  roster: Slot[],
  tl: Timeline,
  mint: () => RecordId,
  written: number = WRITTEN,
  markers?: FrameMarkers,
  waves?: ReadonlyMap<string, { id: RecordId; t: number; more?: More }>,
): Op[][] {
  const second = scene.scene.source?.t;
  const tier = scene.scene.source?.tier ?? null;
  if (second == null || !retakesFrom(tier, tl)) return [];
  const players = new Map(tl.players.map((p) => [slotKey(p.team, p.slot), p]));
  const slots = new Map(roster.map((s) => [s.id, s]));
  const setOp = (id: RecordId, key: string, value: MoreValue | null): Op => ({ Set: { id, value: { More: { key, value } } } });
  const c = captured(state?.more);
  const own = c.heroes;
  const fd = written > 16 ? captureFrameData(tl, Math.floor(second), markers ?? [], written) : undefined;
  // Only backfill Phase 5 features NOT YET CAPTURED (`!c[f.flag]`): never re-write a row belonging
  // to an already-captured feature whose key a coach legitimately cleared (e.g. marking a hero in vision).
  const missingFeatures = new Set<Phase5Feature>();
  if (fd) {
    for (const f of PHASE5_FEATURES) {
      if (ROWS[f.lastRow].index < written && !c[f.flag] && fd.available.has(f.feature)) {
        missingFeatures.add(f.feature);
      }
    }
  }
  const { buildGroups, buildComplete, projectedHero } = planRetakeBuilds(tl, second, tier, own, heroes, roster, fd, missingFeatures, written);
  const groups: Op[][] = [...buildGroups];

  // If `c.rows < 15` and a required build key couldn't fit (`!buildComplete`), do not advance
  // `rows` past 14 or enter Phase 5 features (which would falsely mark rows 11–14 as captured).
  const allowPhase5 = c.rows >= 15 || buildComplete;
  const { admitted: admittedFeatures, skipped: skippedForCap } = fd && allowPhase5 && missingFeatures.size > 0
    ? preflightRetakeFeatures(tl, state?.more, heroes, roster, fd, missingFeatures, written, waves, projectedHero, buildComplete)
    : { admitted: new Set<Phase5Feature>(), skipped: [] as Array<(typeof PHASE5_FEATURES)[number]> };

  // One indivisible scene-state group, emitted last (plan §6): all admitted Group A hero/lane ops
  // plus SceneState (admitted Group A + Group B + dormant flag clears + honest watermark bump),
  // emitted as `Op::Set` so concurrent near-cap overflow aborts the whole transaction atomically.
  const sceneGroup: Op[] = [];
  if (fd && admittedFeatures.size > 0) {
    // Group A hero rows: filled for EVERY matched slot (re-picked or not), never triggering `Set hero`.
    for (const h of heroes) {
      const s = slots.get(h.state.slot);
      if (!s) continue;
      const key = slotKey(s.slot.team, s.slot.slot);
      if (!players.has(key)) continue;
      const have = h.state.more ?? {};
      const extra = heroExtraFrom(fd, admittedFeatures, key);
      for (const [k, v] of Object.entries(extra)) {
        if (have[k] === undefined && ROWS[k as RowKey].index < written) sceneGroup.push(setOp(h.id, k, v));
      }
    }
    // Group A lane edges: fill absent `edges` on existing Waves, or create Wave on metadata-upgraded scenes.
    if (admittedFeatures.has("lanes")) {
      for (const [lane, w] of fd.sec.lanes) {
        const edges = fd.laneEdges.get(lane);
        if (!edges) continue;
        const existing = waves?.get(lane);
        if (existing) {
          if (existing.more?.edges === undefined) sceneGroup.push(setOp(existing.id, "edges", edges));
        } else if (waves !== undefined) {
          sceneGroup.push({ Create: { id: mint(), record: { Wave: { scene: scene.id, lane, t: Math.round((w.amber + w.sapphire) / 2), more: { edges } } } } });
        }
      }
    }
  }
  // Advance `SceneState.rows` only as high as the highest admitted feature (because `captured()`
  // requires `ROWS[lastRow].index < rows` to read an admitted `has_*` flag); never advance past
  // 14 when `c.rows < 15 && !buildComplete`, never advance past admitted features when any feature
  // was skipped, and never bump `rows` on a no-op Retake.
  const rowByFeature = new Map(PHASE5_FEATURES.map((f) => [f.feature, ROWS[f.lastRow].index + 1]));
  const targetRows = !allowPhase5
    ? c.rows
    : skippedForCap.length === 0
      ? written
      : Math.max(
          c.rows,
          buildComplete && (buildGroups.length > 0 || c.rows < 15) ? Math.min(written, 15) : 0,
          ...[...admittedFeatures].map((f) => rowByFeature.get(f) ?? 0),
        );
  // Never `has_heroes`: a scene saved before it draws the board roster's heroes, and stays so.
  // Only set `has_builds: true` when `buildComplete` holds.
  const want = captureScene(tl, { builds: buildComplete, heroes: false, written, ...(fd ? sceneCaptureFrom(fd, admittedFeatures) : {}) });
  want.rows = targetRows;
  if (!state) {
    if (buildComplete || admittedFeatures.size > 0) {
      sceneGroup.push({ Create: { id: mint(), record: { SceneState: { scene: scene.id, more: want } } } });
    }
  } else {
    const have = state.more ?? {};
    for (const [key, value] of Object.entries(want)) {
      if (key === "rows") continue;
      if (key === "build") {
        if (have[key] === undefined) sceneGroup.push(setOp(state.id, key, value));
      } else if (key.startsWith("has_")) {
        // Transitions BOTH absent and explicit `false` flags to `true`.
        if (have[key] !== true) sceneGroup.push(setOp(state.id, key, value));
      } else if (JSON.stringify(have[key]) !== JSON.stringify(value)) {
        sceneGroup.push(setOp(state.id, key, value));
      }
    }
    // Clear any dormant `true` flag beyond the old watermark that `targetRows` would otherwise
    // activate without its data having been captured (e.g. imported `{ rows: 16, has_sight: true }`).
    for (const f of PHASE5_FEATURES) {
      if (!c[f.flag] && !admittedFeatures.has(f.feature) && targetRows > ROWS[f.lastRow].index && have[f.firstRow] === true) {
        sceneGroup.push(setOp(state.id, f.firstRow, null));
      }
    }
    if (!c.builds && !buildComplete && targetRows > 0 && have.has_builds === true) {
      sceneGroup.push(setOp(state.id, "has_builds", null));
    }
    if (!c.heroes && targetRows > ROWS.has_heroes.index && have.has_heroes === true) {
      sceneGroup.push(setOp(state.id, "has_heroes", null));
    }
    const hasWork = buildGroups.length > 0 || sceneGroup.length > 0 || (buildComplete && c.rows < 15);
    if (hasWork && (have.rows === undefined || c.rows < targetRows)) {
      sceneGroup.push(setOp(state.id, "rows", targetRows));
    }
  }
  if (sceneGroup.length) groups.push(sceneGroup);
  return chunkByBytes(groups);
}

/** Whether a scene saved from a match of `tier` can be retaken from `tl`: what the scene reads
 * as captured, `tl` holds (the health of a scene saved from the replay). */
const retakesFrom = (tier: string | null | undefined, tl: Pick<Timeline, "tier">) => !holdsHealth(tier) || holdsHealth(tl.tier);

/** Whether ops fit one transaction's bytes, with room for what wraps them on the wire. */
export const fitsTx = (ops: Op[]) => opsBytes(ops) <= LIMITS.max_tx_bytes - TX_SLACK;

/** Groups of ops as transactions: each within the op and byte caps, a group never split
 * (a group here is one record's writes, itself within both). */
export function chunkByBytes(groups: Op[][]): Op[][] {
  const out: Op[][] = [];
  let cur: Op[] = [];
  let bytes = 0;
  for (const g of groups) {
    const n = opsBytes(g);
    if (cur.length && (cur.length + g.length > LIMITS.max_ops_per_tx || bytes + n > LIMITS.max_tx_bytes - TX_SLACK)) {
      out.push(cur);
      cur = [];
      bytes = 0;
    }
    cur = cur.concat(g);
    bytes += n;
  }
  if (cur.length) out.push(cur);
  return out;
}

export interface SceneOpts {
  /** The scene's name (default "Match moment"). */
  name?: string;
  /** Insert after this order key instead of after the current scene. */
  after?: string;
  /** Set the roster to the match's heroes (default true). Never once the scene holds its own
   * heroes (`has_heroes` written: spec D2). */
  roster?: boolean;
  /** The rows this save writes (default this build's, `WRITTEN`; tests pass a later build's). */
  written?: number;
  /** Where the scene came from (spec §6b): stored for "resume from here". */
  source?: { match_id: number; tier: string };
  /** Store the frame's builds with the scene (default true). */
  builds?: boolean;
  /** Override the per-tx byte budget (tests of DROP_ORDER pass a tighter cap). */
  txBudget?: number;
}

/**
 * A scene's name from a match: the event alone ("Mirage died"), the clock and the ▶ chip carry
 * the time (operator, 2026-11-08); within the schema's 48 characters (`max_scene_name`, counted
 * as the server counts them: characters, so a cut never splits a surrogate pair).
 */
export function sceneName(label: string, _second?: number): string {
  const chars = [...label];
  return chars.length > LIMITS.max_scene_name ? `${chars.slice(0, LIMITS.max_scene_name - 1).join("")}…` : label;
}

/**
 * One scene per moment, in order after the current scene (a build from before `has_heroes` set
 * the roster to the match's heroes once). `groups` holds each scene's ops, to be sent in
 * transactions within the op cap, and `of` the index of its moment: a moment that can't be
 * saved whole (`matchSceneOps`) has no scene, so there may be fewer groups than moments.
 */
export function matchScenesOps(
  roster: Slot[],
  scenes: SceneRow[],
  current: SceneRow | undefined,
  tl: Timeline,
  moments: Array<{ t: number; name: string }>,
  markers: Array<Pick<Marker, "key" | "kind" | "team" | "lane" | "at">>,
  mint: () => RecordId,
  lanes: string[] = [],
): { ids: RecordId[]; ops: Op[]; groups: Op[][]; builds: boolean[]; of: number[] } {
  const builds: boolean[] = [];
  const ids: RecordId[] = [];
  const groups: Op[][] = [];
  const of: number[] = [];
  let after: string | undefined;
  moments.forEach((m, n) => {
    const r = matchSceneOps(roster, scenes, current, tl, m.t, markers, mint, lanes, { name: m.name, ...(after ? { after } : {}), roster: n === 0, source: sourceOf(tl) });
    if (!r.ops.length) return;
    ids.push(r.id);
    builds.push(r.builds);
    groups.push(r.ops);
    of.push(n);
    after = r.order;
  });
  return { ids, ops: groups.flat(), groups, builds, of };
}

/** A timeline's scene source (spec §6b). */
export const sourceOf = (tl: Timeline) => ({ match_id: tl.match_id, tier: tl.tier === "replay" ? "replay" : "metadata" });
