// Phase 5 map-state row packing and unpacking (docs/specs/map-state-phase5-plan.md §2–§3).
//
// Permanent numeric tables, 32-bit FNV-1a marker key hashing with per-pack reverse lookup cache,
// and Group A / Group B codecs shared by `fromScene` (reading) and `match/save.ts` (capturing).
// Pure; no circular imports.

import { clampToMap } from "../map/transform";
import { type CampAt, type DoorNow, type PowerupAt, type RejuvNow, type RiftAt, type UrnNow, slotKey } from "../match/timeline";
import type { CrowdControl } from "../player/cc";
import { SKULL_S } from "../player/skulls";
import type { FrameMarkers } from "./frame";
import type { Death } from "./state";

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/** 32-bit FNV-1a hash of a marker key's UTF-8 bytes, as an unsigned integer (`0..4294967295`). */
export function fnv1a32(key: string): number {
  const bytes = new TextEncoder().encode(key);
  let h = FNV_OFFSET;
  for (let i = 0; i < bytes.length; i++) {
    h = Math.imul(h ^ bytes[i]!, FNV_PRIME) >>> 0;
  }
  return h;
}

export interface MarkerHashIndex {
  byHash: Map<number, string>;
  collisions: Set<number>;
}

const hashIndexCache = new WeakMap<object, MarkerHashIndex>();

/** Reverse lookup from 32-bit FNV-1a hash to marker key, cached per marker array reference. */
export function markerHashIndex(markers: FrameMarkers): MarkerHashIndex {
  const cached = hashIndexCache.get(markers);
  if (cached) return cached;
  const byHash = new Map<number, string>();
  const collisions = new Set<number>();
  for (const m of markers) {
    const h = fnv1a32(m.key);
    const prev = byHash.get(h);
    if (prev !== undefined && prev !== m.key) {
      collisions.add(h);
      byHash.delete(h);
    } else if (!collisions.has(h)) {
      byHash.set(h, m.key);
    }
  }
  const index = { byHash, collisions };
  hashIndexCache.set(markers, index);
  return index;
}

/** Marker kinds covered by `has_camps` / `camps`. */
export const isCampKind = (kind: string): boolean => kind === "camp" || kind === "heal" || kind === "crate" || kind === "midboss";

/** Marker kinds that hold objective health (`has_obj_health` / `obj_health`). */
export const isHealthKind = (kind: string): boolean =>
  kind === "t1" || kind === "t2" || kind === "barracks" || kind === "shrine" || kind === "t3" || kind === "midboss";

// ---- Permanent numeric tables (plan §2) ----

const CC_TO_CODE: Record<CrowdControl, number> = { Stunned: 1, Silenced: 2, Disarmed: 3 };
const CODE_TO_CC: Record<number, CrowdControl> = { 1: "Stunned", 2: "Silenced", 3: "Disarmed" };

export const encodeCC = (cc: CrowdControl | undefined): number | undefined => (cc ? CC_TO_CODE[cc] : undefined);
export const decodeCC = (v: unknown): CrowdControl | undefined => (typeof v === "number" ? CODE_TO_CC[v] : undefined);

const BUFF_TO_CODE: Record<string, number> = { casting: 0, gun: 1, movement: 2, survival: 3 };
const CODE_TO_BUFF: Record<number, string> = { 0: "casting", 1: "gun", 2: "movement", 3: "survival" };

export const encodeBuff = (buff: string): number => (buff in BUFF_TO_CODE ? BUFF_TO_CODE[buff]! : -1);
export const decodeBuff = (code: number): string => CODE_TO_BUFF[code] ?? "";

export const encodeTeam = (team: "amber" | "sapphire" | null | undefined): number =>
  team === "amber" ? 0 : team === "sapphire" ? 1 : -1;
export const decodeTeam = (code: number): "amber" | "sapphire" | null =>
  code === 0 ? "amber" : code === 1 ? "sapphire" : null;

export const encodeSlot = (team: "amber" | "sapphire", slot: number): number => (team === "amber" ? 0 : 6) + slot;
export function decodeSlot(code: number): { team: "amber" | "sapphire"; slot: number; key: string } | undefined {
  if (!Number.isInteger(code) || code < 0 || code > 11) return undefined;
  const team = code < 6 ? "amber" : "sapphire";
  const slot = code % 6;
  return { team, slot, key: slotKey(team, slot) };
}

function strides(list: unknown, stride: number): number[][] | null {
  if (!Array.isArray(list) || list.length % stride !== 0 || !list.every((n) => Number.isInteger(n))) return null;
  return Array.from({ length: list.length / stride }, (_, i) => (list as number[]).slice(i * stride, (i + 1) * stride));
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(n)));

// ---- Group A codecs ----

export function encodeEdges(w: { amber: number; sapphire: number }): number[] {
  return [clamp(w.amber, 0, 1000), clamp(w.sapphire, 0, 1000)];
}

export function decodeEdges(v: unknown): { amber: number; sapphire: number } | undefined {
  if (!Array.isArray(v) || v.length !== 2 || !Number.isInteger(v[0]) || !Number.isInteger(v[1])) return undefined;
  const [a, b] = v as [number, number];
  if (a < 0 || a > 1000 || b < 0 || b > 1000) return undefined;
  return { amber: a, sapphire: b };
}

export const MAX_SKULLS = 12;

export function encodeSkulls(deaths: readonly Death[], second: number): number[] {
  const out: number[] = [];
  for (const d of deaths) {
    if (out.length >= MAX_SKULLS * 3) break;
    const parts = d.slot.split("-");
    const slotNum = Number(parts[1]);
    if (!Number.isInteger(slotNum) || slotNum < 0 || slotNum > 5) continue;
    const tenthsAgo = clamp((second - d.t) * 10, 0, 24);
    out.push(encodeSlot(d.team, slotNum), tenthsAgo, d.seen ? 1 : 0);
  }
  return out;
}

export function decodeSkulls(
  v: unknown,
  frame: number,
  heroAt: (slot: string) => { alive: boolean; last: { x: number; y: number } | null },
): Death[] {
  const rows = strides(v, 3);
  if (!rows) return [];
  const out: Death[] = [];
  for (const [slotCode, tenthsAgo, seenInt] of rows) {
    const info = decodeSlot(slotCode!);
    if (!info || tenthsAgo! < 0 || tenthsAgo! > 24) continue;
    const h = heroAt(info.key);
    // Reviving a dead hero hides its skull; dragging a dead hero moves its skull (plan §2).
    if (h.alive || !h.last) continue;
    const age = tenthsAgo! / 10;
    out.push({
      slot: info.key,
      team: info.team,
      at: h.last,
      t: frame - age,
      opacity: Math.max(0, 1 - (age / SKULL_S) ** 2),
      seen: seenInt === 1,
    });
  }
  return out;
}

// ---- Group B codecs ----

export const MAX_CAMPS = 200;
export const MAX_POWERUPS = 4;
export const MAX_OBJ_HEALTH = 40;

export function encodeCamps(
  camps: ReadonlyMap<string, CampAt>,
  second: number,
  markers: FrameMarkers,
): { ints: number[]; skipped: Set<string>; overflow: boolean } {
  const { collisions } = markerHashIndex(markers);
  const skipped = new Set<string>();
  const entries = [...camps.entries()]
    .filter(([, c]) => c.state !== "alive")
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const ints: number[] = [];
  let count = 0;
  for (const [key, c] of entries) {
    if (c.state === "alive") continue;
    const h = fnv1a32(key);
    if (collisions.has(h)) {
      skipped.add(key);
      continue;
    }
    count++;
    if (count > MAX_CAMPS) return { ints: [], skipped: new Set(), overflow: true };
    const code = c.state === "cleared" ? 1 : 2;
    const left = Math.max(0, Math.round(c.at - second));
    ints.push(h, code, left);
  }
  return { ints, skipped, overflow: false };
}

export function decodeCamps(v: unknown, frame: number, markers: FrameMarkers): Map<string, CampAt> {
  const out = new Map<string, CampAt>();
  const rows = strides(v, 3);
  if (!rows) return out;
  const { byHash } = markerHashIndex(markers);
  for (const [h, code, left] of rows) {
    const key = byHash.get(h!);
    if (!key || left! < 0) continue;
    if (code === 1) out.set(key, { state: "cleared", at: frame + left! });
    else if (code === 2) out.set(key, { state: "unspawned", at: frame + left! });
  }
  return out;
}

export function encodePowerups(
  powerups: ReadonlyMap<string, PowerupAt>,
  second: number,
  markers: FrameMarkers,
): { ints: number[]; skipped: Set<string>; overflow: boolean } {
  const { collisions } = markerHashIndex(markers);
  const skipped = new Set<string>();
  const entries = [...powerups.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const ints: number[] = [];
  let count = 0;
  for (const [key, p] of entries) {
    const h = fnv1a32(key);
    if (collisions.has(h)) {
      skipped.add(key);
      continue;
    }
    count++;
    if (count > MAX_POWERUPS) return { ints: [], skipped: new Set(), overflow: true };
    if (p.state === "up") {
      ints.push(h, 0, encodeBuff(p.buff), -1, -1);
    } else {
      const nextIn = p.next ? Math.max(0, Math.round(p.next.t - second)) : -1;
      const nextBuff = p.next ? encodeBuff(p.next.buff) : -1;
      ints.push(h, p.first ? 2 : 1, -1, nextIn, nextBuff);
    }
  }
  return { ints, skipped, overflow: false };
}

export function decodePowerups(v: unknown, frame: number, markers: FrameMarkers): Map<string, PowerupAt> {
  const out = new Map<string, PowerupAt>();
  const rows = strides(v, 5);
  if (!rows) return out;
  const { byHash } = markerHashIndex(markers);
  for (const [h, st, buffCode, nextIn, nextBuffCode] of rows) {
    const key = byHash.get(h!);
    if (!key) continue;
    if (st === 0) {
      out.set(key, { state: "up", buff: decodeBuff(buffCode!) });
    } else if (st === 1 || st === 2) {
      out.set(key, {
        state: "down",
        first: st === 2,
        next: nextIn! >= 0 ? { t: frame + nextIn!, buff: decodeBuff(nextBuffCode!) } : null,
      });
    }
  }
  return out;
}

export function encodeObjHealth(
  health: ReadonlyMap<string, { pct: number; stage?: number }>,
  markers: FrameMarkers,
  down?: ReadonlySet<string>,
): { ints: number[]; skipped: Set<string>; overflow: boolean } {
  const { collisions } = markerHashIndex(markers);
  const skipped = new Set<string>();
  const rows: Array<[string, number, number]> = [];
  for (const [key, o] of health) {
    const pct = clamp(o.pct, 0, 100);
    const stage = o.stage === 1 || o.stage === 2 ? o.stage : -1;
    // Default (not stored): 100%, no stage.
    if (pct === 100 && stage === -1) continue;
    rows.push([key, pct, stage]);
  }
  // When `down` is supplied (Save/Retake), explicitly mark standing `isHealthKind` objectives
  // absent from a partial `objective_health` timeline as unknown (`pct = -1`) so Save never
  // invents `100%` hovers; deployed R2.1 (`9d1f206`) decodes `pct === -1` as unknown (`null`).
  if (down) {
    for (const mk of markers) {
      if (!isHealthKind(mk.kind) || down.has(mk.key) || health.has(mk.key)) continue;
      rows.push([mk.key, -1, -1]);
    }
  }
  rows.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const ints: number[] = [];
  let count = 0;
  for (const [key, pct, stage] of rows) {
    const h = fnv1a32(key);
    if (collisions.has(h)) {
      skipped.add(key);
      continue;
    }
    count++;
    if (count > MAX_OBJ_HEALTH) return { ints: [], skipped: new Set(), overflow: true };
    ints.push(h, pct, stage);
  }
  return { ints, skipped, overflow: false };
}

export function decodeObjHealth(v: unknown, markers: FrameMarkers): Map<string, { pct: number; stage?: number } | null> {
  const out = new Map<string, { pct: number; stage?: number } | null>();
  const rows = strides(v, 3);
  if (!rows) return out;
  const { byHash } = markerHashIndex(markers);
  for (const [h, pct, stage] of rows) {
    const key = byHash.get(h!);
    if (!key) continue;
    if (pct === -1) {
      out.set(key, null);
      continue;
    }
    if (pct! < 0 || pct! > 100) continue;
    out.set(key, stage === 1 || stage === 2 ? { pct: pct!, stage } : { pct: pct! });
  }
  return out;
}

export function encodeRift(
  rifts: ReadonlyMap<string, RiftAt>,
  second: number,
  markers: FrameMarkers,
  announcedKey?: string | null,
): { ints: number[]; collision: boolean } {
  const { collisions } = markerHashIndex(markers);
  for (const [key, r] of rifts) {
    if (r.state !== "active") continue;
    const h = fnv1a32(key);
    if (collisions.has(h)) return { ints: [], collision: true };
    const giveUpIn = r.giveUp != null ? Math.max(0, Math.round(r.giveUp - second)) : -1;
    const amber = r.capture ? clamp(r.capture.amber, 0, 100) : -1;
    const sapphire = r.capture ? clamp(r.capture.sapphire, 0, 100) : -1;
    const cap = r.capture ? encodeTeam(r.capture.captured) : -1;
    return { ints: [1, h, giveUpIn, amber, sapphire, cap, -1, -1], collision: false };
  }
  // During the pre-live announcement window (`start_s <= t < live_s`), `open === 0` carries the
  // announced site hash in slot 1 (`siteHash`); deployed R2.1 (`9d1f206`) decodes `announcedKey`
  // alongside `waiting` so both lit icon and opening countdown match on rollback.
  let annHash = -1;
  if (announcedKey) {
    annHash = fnv1a32(announcedKey);
    if (collisions.has(annHash)) return { ints: [], collision: true };
  }
  let waiting: { t: number; key: string } | null = null;
  for (const [, r] of rifts) {
    if (r.state === "waiting") {
      waiting = r.next;
      break;
    }
  }
  if (waiting) {
    const h = fnv1a32(waiting.key);
    if (collisions.has(h)) return { ints: [], collision: true };
    const nextIn = Math.max(0, Math.round(waiting.t - second));
    return { ints: [0, annHash, -1, -1, -1, -1, nextIn, h], collision: false };
  }
  return { ints: [0, annHash, -1, -1, -1, -1, -1, -1], collision: false };
}

export interface DecodedRift {
  activeKey: string | null;
  /** Pre-live announced site (`start_s <= t < live_s`, `open === 0 && siteHash >= 0`). */
  announcedKey: string | null;
  active: RiftAt | null;
  waiting: RiftAt;
}

export function decodeRift(v: unknown, frame: number, markers: FrameMarkers): DecodedRift | undefined {
  if (!Array.isArray(v) || v.length !== 8 || !v.every((n) => Number.isInteger(n))) return undefined;
  const [open, siteHash, giveUpIn, amberPct, sapphirePct, capturedCode, nextIn, nextSiteHash] = v as number[];
  const { byHash } = markerHashIndex(markers);
  if (open === 1) {
    const key = siteHash! >= 0 ? (byHash.get(siteHash!) ?? null) : null;
    if (key) {
      const capture =
        amberPct! >= 0 && sapphirePct! >= 0
          ? { amber: amberPct!, sapphire: sapphirePct!, captured: decodeTeam(capturedCode!) }
          : null;
      return {
        activeKey: key,
        announcedKey: null,
        active: { state: "active", giveUp: giveUpIn! >= 0 ? frame + giveUpIn! : null, capture },
        waiting: { state: "waiting", next: null },
      };
    }
  }
  const announcedKey = open === 0 && siteHash! >= 0 ? (byHash.get(siteHash!) ?? null) : null;
  const nextKey = nextIn! >= 0 && nextSiteHash! >= 0 ? byHash.get(nextSiteHash!) : undefined;
  return {
    activeKey: null,
    announcedKey,
    active: null,
    waiting: { state: "waiting", next: nextIn! >= 0 && nextKey ? { t: frame + nextIn!, key: nextKey } : null },
  };
}

export function encodeUrn(
  urn: UrnNow,
  second: number,
  markers: FrameMarkers,
): { ints: number[]; at?: { x: number; y: number }; collision: boolean } {
  const { collisions } = markerHashIndex(markers);
  let deliveryHash = -1;
  if (urn.delivery) {
    const h = fnv1a32(urn.delivery);
    if (collisions.has(h)) return { ints: [], collision: true };
    deliveryHash = h;
  }
  let nextIn = -1;
  let nextSiteHash = -1;
  if (urn.next) {
    const h = fnv1a32(urn.next.key);
    if (collisions.has(h)) return { ints: [], collision: true };
    nextIn = Math.max(0, Math.round(urn.next.t - second));
    nextSiteHash = h;
  }
  const stateCode = urn.state === "ground" ? 1 : urn.state === "carried" ? 2 : 0;
  const teamCode = encodeTeam(urn.team);
  const slotNum = urn.slot != null && urn.slot >= 0 && urn.slot <= 5 ? urn.slot : -1;
  let walkBackIn = -1;
  if (urn.state === "ground" && urn.returns != null) {
    walkBackIn = urn.returns <= second ? 0 : Math.max(1, Math.round(urn.returns - second));
  }
  const ints = [stateCode, teamCode, slotNum, deliveryHash, walkBackIn, nextIn, nextSiteHash];
  const at = urn.state === "ground" && urn.at ? clampToMap({ x: urn.at.x, y: urn.at.y }) : undefined;
  return at ? { ints, at, collision: false } : { ints, collision: false };
}

export function decodeUrn(
  v: unknown,
  atVal: unknown,
  frame: number,
  markers: FrameMarkers,
  carrierAt: (slot: string) => { x: number; y: number } | null,
): UrnNow | undefined {
  if (!Array.isArray(v) || v.length < 7 || !v.every((n) => Number.isInteger(n))) return undefined;
  const [st, teamCode, slotNum, deliveryHash, walkBackIn, nextIn, nextSiteHash] = v as number[];
  const { byHash } = markerHashIndex(markers);
  const state = st === 1 ? "ground" : st === 2 ? "carried" : "none";
  const team = decodeTeam(teamCode!);
  const slot = slotNum! >= 0 && slotNum! <= 5 ? slotNum! : null;
  const delivery = deliveryHash! >= 0 ? (byHash.get(deliveryHash!) ?? null) : null;
  const nextKey = nextIn! >= 0 && nextSiteHash! >= 0 ? byHash.get(nextSiteHash!) : undefined;
  const next = nextIn! >= 0 && nextKey ? { t: frame + nextIn!, key: nextKey } : null;
  if (state === "ground") {
    const pos =
      atVal && typeof atVal === "object" && "x" in atVal && "y" in atVal && typeof (atVal as { x: unknown }).x === "number" && typeof (atVal as { y: unknown }).y === "number"
        ? { x: (atVal as { x: number }).x, y: (atVal as { y: number }).y }
        : null;
    return {
      state: "ground",
      at: pos,
      team,
      slot,
      delivery,
      next,
      returns: walkBackIn! < 0 ? null : frame + walkBackIn!,
    };
  }
  if (state === "carried") {
    const at = team && slot != null ? carrierAt(slotKey(team, slot)) : null;
    return { state: "carried", at, team, slot, delivery, next };
  }
  return { state: "none", at: null, team: null, slot: null, delivery: null, next };
}

export function encodeRejuv(rejuv: readonly RejuvNow[], second: number): number[] {
  const out: number[] = [];
  for (const r of rejuv.slice(0, 2)) {
    const tc = encodeTeam(r.team);
    if (tc < 0) continue;
    out.push(tc, Math.max(0, Math.round(r.left)), Math.max(0, Math.round(r.ends - second)), Math.max(0, Math.round(second - r.taken)));
  }
  return out;
}

export function decodeRejuv(v: unknown, frame: number): RejuvNow[] {
  const rows = strides(v, 4);
  if (!rows) return [];
  const out: RejuvNow[] = [];
  for (const [teamCode, left, endsIn, sinceTaken] of rows) {
    const team = decodeTeam(teamCode!);
    if (!team || left! < 0 || endsIn! < 0 || sinceTaken! < 0) continue;
    out.push({ team, left: left!, ends: frame + endsIn!, taken: frame - sinceTaken! });
  }
  return out;
}

// ---- Doorman doorways codec (rows 40–41; docs/specs/doorman-doors-design.md §3.3) ----

export const MAX_DOORS = 4;
export const DOOR_STRIDE = 6;

export function encodeDoors(doors: readonly DoorNow[]): number[] {
  const kept = doors.filter((d) => encodeTeam(d.team) >= 0).slice(0, MAX_DOORS);
  const byId = new Map<number, number>();
  kept.forEach((d, i) => byId.set(d.id, i));
  const out: number[] = [];
  for (let i = 0; i < kept.length; i++) {
    const d = kept[i]!;
    const tc = encodeTeam(d.team);
    const at = clampToMap(d.at);
    const pj = d.role !== "unpaired" && d.partner != null ? byId.get(d.partner) : undefined;
    const p = pj !== undefined && pj !== i ? kept[pj] : undefined;
    const complementary = p !== undefined && ((d.role === "door1" && p.role === "door2") || (d.role === "door2" && p.role === "door1"));
    const linked = complementary && p.team === d.team && p.partner === d.id;
    const roleCode = !linked ? 0 : d.role === "door1" ? 1 : 2;
    const partnerIdx = linked ? pj! : -1;
    out.push(tc, at.x, at.y, roleCode, partnerIdx, d.inSight ? 0 : 1);
  }
  return out;
}

export function decodeDoors(v: unknown): DoorNow[] {
  const rows = strides(v, DOOR_STRIDE);
  if (!rows || rows.length > MAX_DOORS) return [];
  interface Parsed {
    orig: number;
    team: "amber" | "sapphire";
    at: { x: number; y: number };
    roleCode: 0 | 1 | 2;
    partnerIdx: number;
    inSight: boolean;
  }
  const parsed: Array<Parsed | null> = rows.map(([teamCode, x, y, roleCode, partnerIdx, unseenInt], orig) => {
    const team = decodeTeam(teamCode!);
    if (!team || (roleCode !== 0 && roleCode !== 1 && roleCode !== 2) || (unseenInt !== 0 && unseenInt !== 1)) return null;
    return {
      orig,
      team,
      at: clampToMap({ x: x!, y: y! }),
      roleCode,
      partnerIdx: partnerIdx!,
      inSight: unseenInt === 0,
    };
  });
  const origToOut = new Map<number, number>();
  for (const row of parsed) {
    if (row) origToOut.set(row.orig, origToOut.size);
  }
  const out: DoorNow[] = [];
  for (const row of parsed) {
    if (!row) continue;
    const id = origToOut.get(row.orig)!;
    const p = row.roleCode !== 0 && row.partnerIdx !== row.orig ? parsed[row.partnerIdx] : null;
    const complementary = p != null && ((row.roleCode === 1 && p.roleCode === 2) || (row.roleCode === 2 && p.roleCode === 1));
    const linked = complementary && p.team === row.team && p.partnerIdx === row.orig && origToOut.has(p.orig);
    out.push({
      id,
      team: row.team,
      at: row.at,
      role: !linked ? "unpaired" : row.roleCode === 1 ? "door1" : "door2",
      partner: linked ? origToOut.get(p.orig)! : null,
      inSight: row.inSight,
    });
  }
  return out;
}
