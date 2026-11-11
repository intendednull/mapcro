// The replay tier's lane troopers as dots (a debug view of the waves; spec §6b): decode the
// timeline's packed samples and place each trooper at playback time t, sliding one that's in
// both samples, never inventing one that isn't. Pure.

import type { Timeline } from "../match/timeline";

export interface Dot {
  team: "amber" | "sapphire";
  /** As recorded: the entity index, with [`RIFT_TROOPER`] set on a rift's. */
  id: number;
  x: number;
  y: number;
  /** Spawned by a captured rift: the game draws it bigger and darker. */
  rift: boolean;
}

/** Bit 15 of a trooper's id: a captured rift spawned it (timeline.rs `RIFT_TROOPER`). */
export const RIFT_TROOPER = 0x8000;

/** One packed sample: little-endian `[id: u16, x: i16, y: i16]` triples, base64. */
export function decodeSample(b64: string): Array<[number, number, number]> {
  if (!b64) return [];
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const v = new DataView(bytes.buffer);
  const out: Array<[number, number, number]> = [];
  for (let o = 0; o + 6 <= bytes.length; o += 6) out.push([v.getUint16(o, true), v.getInt16(o + 2, true), v.getInt16(o + 4, true)]);
  return out;
}

const cache = new WeakMap<object, Map<string, Array<[number, number, number]>>>();
function sample(tl: Timeline, team: "amber" | "sapphire", k: number): Array<[number, number, number]> {
  const tr = tl.troopers;
  if (!tr) return [];
  let c = cache.get(tr);
  if (!c) cache.set(tr, (c = new Map()));
  const key = `${team}${k}`;
  let v = c.get(key);
  if (!v) c.set(key, (v = decodeSample(tr[team][k] ?? "")));
  return v;
}

/** Every trooper between samples `k` and `k + 1`: where it is in each (absent: not there). */
interface Pair {
  team: "amber" | "sapphire";
  id: number;
  a: [number, number] | undefined;
  b: [number, number] | undefined;
}
// The pairs for the last sample interval asked for, per timeline: playback asks for the same one
// some 60 times a second, so it's matched up once (a 100+ trooper frame at 8× stays cheap).
const pairCache = new WeakMap<object, { k: number; pairs: Pair[] }>();
function pairsAt(tl: Timeline, k: number): Pair[] {
  const tr = tl.troopers!;
  const hit = pairCache.get(tr);
  if (hit?.k === k) return hit.pairs;
  const pairs: Pair[] = [];
  for (const team of ["amber", "sapphire"] as const) {
    const a = sample(tl, team, k);
    const b = sample(tl, team, k + 1);
    const later = new Map(b.map((p) => [p[0], p]));
    for (const [id, x, y] of a) {
      const n = later.get(id);
      pairs.push({ team, id, a: [x, y], b: n ? [n[1], n[2]] : undefined });
    }
    const earlier = new Set(a.map((p) => p[0]));
    for (const [id, x, y] of b) if (!earlier.has(id)) pairs.push({ team, id, a: undefined, b: [x, y] });
  }
  pairCache.set(tr, { k, pairs });
  return pairs;
}

/**
 * Every trooper at t: slid between the two samples around t when it's in both; one in only the
 * first (it died) shows until halfway, one in only the second (it spawned) from halfway.
 */
export function troopersAt(tl: Timeline, t: number): Dot[] {
  const tr = tl.troopers;
  if (!tr) return [];
  const every = Math.max(1, tr.every_s);
  const k0 = Math.max(0, Math.floor(t / every));
  const f = Math.max(0, Math.min(1, t / every - k0));
  const out: Dot[] = [];
  for (const { team, id, a, b } of pairsAt(tl, k0)) {
    const rift = (id & RIFT_TROOPER) !== 0;
    if (a && b) out.push({ team, id, x: a[0] + (b[0] - a[0]) * f, y: a[1] + (b[1] - a[1]) * f, rift });
    else if (a && f < 0.5) out.push({ team, id, x: a[0], y: a[1], rift });
    else if (b && f >= 0.5) out.push({ team, id, x: b[0], y: b[1], rift });
  }
  return out;
}
