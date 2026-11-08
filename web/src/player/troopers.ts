// The replay tier's lane troopers as dots (a debug view of the waves; spec §6b): decode the
// timeline's packed samples and place each trooper at playback time t, sliding one that's in
// both samples, never inventing one that isn't. Pure.

import type { Timeline } from "../match/timeline";

export interface Dot {
  team: "amber" | "sapphire";
  id: number;
  x: number;
  y: number;
}

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

/** Every trooper at t: slid between the two samples around t when it's in both. */
export function troopersAt(tl: Timeline, t: number): Dot[] {
  const tr = tl.troopers;
  if (!tr) return [];
  const every = Math.max(1, tr.every_s);
  const k0 = Math.max(0, Math.floor(t / every));
  const f = Math.max(0, Math.min(1, t / every - k0));
  const out: Dot[] = [];
  for (const team of ["amber", "sapphire"] as const) {
    const a = sample(tl, team, k0);
    const b = sample(tl, team, k0 + 1);
    const later = new Map(b.map((p) => [p[0], p]));
    for (const [id, x, y] of a) {
      const n = later.get(id);
      if (n) out.push({ team, id, x: x + (n[1] - x) * f, y: y + (n[2] - y) * f });
      else if (f < 0.5) out.push({ team, id, x, y });
    }
    if (f >= 0.5) {
      const earlier = new Set(a.map((p) => p[0]));
      for (const [id, x, y] of b) if (!earlier.has(id)) out.push({ team, id, x, y });
    }
  }
  return out;
}
