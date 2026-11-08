// What a simulated person does to the board: each action becomes one transaction, built from
// what that person's own view shows, the way the UI builds it. Targets are chosen from the
// schedule's parameters (`r`), so the decisions are the seed's; which records exist to choose
// from depends on timing, as it would for people.

import type { Entry } from "../src/gen/Entry";
import type { Op } from "../src/gen/Op";
import type { RecordId } from "../src/gen/RecordId";
import type { WorldPos } from "../src/gen/WorldPos";
import type { Record as BoardRecord } from "../src/gen/Record";
import type { PlayerState } from "../src/gen/PlayerState";
import type { Rng } from "./rng";

export type Records = Map<RecordId, Entry>;

type Kind = BoardRecord extends infer R ? (R extends Record<infer K, unknown> ? K : never) : never;

const OBJECTIVES = [
  "walker:amber:lane1",
  "walker:amber:lane4",
  "walker:sapphire:lane1",
  "walker:sapphire:lane6",
  "guardian:amber:lane4",
  "shrine:sapphire",
  "patron:amber",
  "midboss",
];
const LANES = ["lane1", "lane4", "lane6"];
const WORDS = ["push", "gank", "rotate", "hold", "urn", "smoke", "mid", "jungle", "flex", "group", "ward", "split"];

export function live<K extends Kind>(records: Records, kind: K): Array<[RecordId, Extract<BoardRecord, Record<K, unknown>>[K]]> {
  const out: Array<[RecordId, never]> = [];
  for (const [id, e] of records) {
    if (!e.deleted && kind in e.record) out.push([id, (e.record as unknown as Record<string, never>)[kind]!]);
  }
  out.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return out as never;
}

/** Live scenes in board order. */
export function scenes(records: Records) {
  return live(records, "Scene").sort(([ia, a], [ib, b]) => (a.order < b.order ? -1 : a.order > b.order ? 1 : ia < ib ? -1 : 1));
}

const at = <T>(xs: readonly T[], r: number): T | undefined => xs[Math.floor(r * xs.length)];
const coord = (r: number) => Math.round((r * 2 - 1) * 15000);
const clamp = (v: number) => Math.max(-16000, Math.min(16000, Math.round(v)));
const pos = (a: number, b: number): WorldPos => ({ x: coord(a), y: coord(b) });
const phrase = (r: number, n: number) => {
  let s = "";
  let x = Math.floor(r * 2 ** 31);
  for (let i = 0; i < n; i++) {
    s += (i ? " " : "") + WORDS[x % WORDS.length];
    x = Math.floor(x / 7) + 13 * i;
  }
  return s;
};
/** A valid order key ([0-9a-z], 1–32 chars, not ending in 0). */
const orderKey = (a: number, b: number) => {
  const d = "0123456789abcdefghijklmnopqrstuvwxyz";
  const len = 1 + Math.floor(a * 5);
  let s = "";
  let x = Math.floor(b * 36 ** 5);
  for (let i = 0; i < len; i++) {
    s += d[x % 36];
    x = Math.floor(x / 36);
  }
  return s.endsWith("0") ? `${s.slice(0, -1)}h` : s;
};

export function playersOf(records: Records, scene: RecordId): Array<[RecordId, PlayerState]> {
  return live(records, "PlayerState").filter(([, p]) => p.scene === scene);
}

/** The scene this person is looking at, if it still exists, else the first. */
export function sceneOf(records: Records, current: RecordId | null): RecordId | undefined {
  const all = scenes(records);
  if (current && all.some(([id]) => id === current)) return current;
  return all[0]?.[0];
}

export interface Built {
  ops: Op[];
  /** For gestures: what the drag preview shows moving. */
  drag?: { id: RecordId; from: WorldPos; to: WorldPos; group: RecordId[] };
}

/** Ops for one editing action, or undefined if there is nothing to do it to. */
export function build(k: string, r: number[], records: Records, scene: RecordId, ids: Rng): Built | undefined {
  const [r0 = 0, r1 = 0, r2 = 0, r3 = 0, r4 = 0, r5 = 0] = r;
  const players = playersOf(records, scene);
  const kindIn = <K extends "Stroke" | "Arrow" | "Callout" | "Note" | "ObjectiveState" | "Wave">(kind: K) =>
    live(records, kind).filter(([, x]) => (x as { scene: RecordId }).scene === scene);
  switch (k) {
    case "move": {
      const p = at(players, r0);
      if (!p) return;
      const to = { x: clamp(p[1].pos.x + (r1 - 0.5) * 6000), y: clamp(p[1].pos.y + (r2 - 0.5) * 6000) };
      return { ops: [{ Set: { id: p[0], value: { PlayerPos: to } } }], drag: { id: p[0], from: p[1].pos, to, group: [] } };
    }
    case "group": {
      const n = 2 + Math.floor(r3 * 3);
      const start = Math.floor(r0 * players.length);
      const group = Array.from({ length: Math.min(n, players.length) }, (_, i) => players[(start + i) % players.length]!);
      const lead = group[0];
      if (!lead) return;
      const dx = Math.round((r1 - 0.5) * 5000);
      const dy = Math.round((r2 - 0.5) * 5000);
      const ops: Op[] = group.map(([id, p]) => ({ Set: { id, value: { PlayerPos: { x: clamp(p.pos.x + dx), y: clamp(p.pos.y + dy) } } } }));
      const to = { x: clamp(lead[1].pos.x + dx), y: clamp(lead[1].pos.y + dy) };
      return { ops, drag: { id: lead[0], from: lead[1].pos, to, group: group.slice(1).map(([id]) => id) } };
    }
    case "souls": {
      const p = at(players, r0);
      return p && { ops: [{ Set: { id: p[0], value: { PlayerSouls: r1 < 0.1 ? null : Math.floor(r2 * 60000) } } }] };
    }
    case "ult": {
      const p = at(players, r0);
      return p && { ops: [{ Set: { id: p[0], value: { PlayerUltCooldown: r1 < 0.1 ? null : Math.floor(r2 * 101) } } }] };
    }
    case "alive": {
      const p = at(players, r0);
      if (!p) return;
      if (r1 < 0.6) return { ops: [{ Set: { id: p[0], value: { PlayerAlive: !p[1].alive } } }] };
      if (r1 < 0.8) return { ops: [{ Set: { id: p[0], value: { PlayerVisible: !p[1].visible } } }] };
      return { ops: [{ Set: { id: p[0], value: { PlayerPlaced: !p[1].placed } } }] };
    }
    case "clock":
      return { ops: [{ Set: { id: scene, value: { SceneClock: r1 < 0.1 ? null : Math.floor(r2 * 3600) } } }] };
    case "roster": {
      const slot = at(live(records, "RosterSlot"), r0);
      if (!slot) return;
      return r1 < 0.5
        ? { ops: [{ Set: { id: slot[0], value: { RosterName: phrase(r2, 1).slice(0, 12) + Math.floor(r3 * 100) } } }] }
        : { ops: [{ Set: { id: slot[0], value: { RosterHero: r2 < 0.1 ? null : 1 + Math.floor(r3 * 60) } } }] };
    }
    case "title": {
      const meta = live(records, "BoardMeta")[0];
      return meta && { ops: [{ Set: { id: meta[0], value: { Title: `Board ${phrase(r1, 2)}` } } }] };
    }
    case "stroke": {
      const n = 2 + Math.floor(r1 * 38);
      const points: WorldPos[] = [];
      let p = pos(r2, r3);
      for (let i = 0; i < n; i++) {
        points.push(p);
        p = { x: clamp(p.x + ((i * 7919 + n) % 400) - 200), y: clamp(p.y + ((i * 104729 + n) % 300) - 150) };
      }
      const record: BoardRecord = { Stroke: { scene, points, color: Math.floor(r4 * 16), width: 1 + Math.floor(r5 * 199) } };
      return { ops: [{ Create: { id: ids.hex128(), record } }] };
    }
    case "arrow": {
      const team = r4 < 0.33 ? null : r4 < 0.66 ? "Amber" : "Sapphire";
      return { ops: [{ Create: { id: ids.hex128(), record: { Arrow: { scene, from: pos(r1, r2), to: pos(r3, r5), team } } } }] };
    }
    case "arrowEdit": {
      const a = at(kindIn("Arrow"), r0);
      if (!a) return;
      if (r1 < 0.4) return { ops: [{ Set: { id: a[0], value: { ArrowTo: pos(r2, r3) } } }] };
      if (r1 < 0.8) return { ops: [{ Set: { id: a[0], value: { ArrowFrom: pos(r2, r3) } } }] };
      return { ops: [{ Set: { id: a[0], value: { ArrowTeam: r2 < 0.5 ? "Amber" : null } } }] };
    }
    case "callout":
      return { ops: [{ Create: { id: ids.hex128(), record: { Callout: { scene, pos: pos(r1, r2), text: phrase(r3, 1 + Math.floor(r4 * 4)) } } } }] };
    case "calloutEdit": {
      const c = at(kindIn("Callout"), r0);
      if (!c) return;
      return r1 < 0.6
        ? { ops: [{ Set: { id: c[0], value: { CalloutText: phrase(r2, 1 + Math.floor(r3 * 5)).slice(0, 80) } } }] }
        : { ops: [{ Set: { id: c[0], value: { CalloutPos: pos(r2, r3) } } }] };
    }
    case "note": {
      const text = phrase(r1, 5 + Math.floor(r2 * 60)).slice(0, 4000);
      const note = kindIn("Note")[0];
      if (note) return { ops: [{ Set: { id: note[0], value: { NoteText: text } } }] };
      return { ops: [{ Create: { id: ids.hex128(), record: { Note: { scene, text } } } }] };
    }
    case "erase": {
      const pool = [...kindIn("Stroke"), ...kindIn("Arrow"), ...kindIn("Callout")];
      if (r1 < 0.15) {
        // "Clear ink": every stroke on this scene as one undoable step.
        const ink = kindIn("Stroke").slice(0, 200);
        return ink.length ? { ops: ink.map(([id]) => ({ Delete: { id } })) } : undefined;
      }
      const x = at(pool, r0);
      return x && { ops: [{ Delete: { id: x[0] } }] };
    }
    case "objective": {
      const key = at(OBJECTIVES, r0)!;
      const o = kindIn("ObjectiveState").find(([, s]) => s.key === key);
      const cycle = { Active: "Destroyed", Stage2: "Destroyed", Destroyed: "Hidden", Hidden: "Active" } as const;
      if (o) return { ops: [{ Set: { id: o[0], value: { ObjectiveStatus: cycle[o[1].status] } } }] };
      return { ops: [{ Create: { id: ids.hex128(), record: { ObjectiveState: { scene, key, status: "Destroyed" } } } }] };
    }
    case "wave": {
      const lane = at(LANES, r0)!;
      const w = kindIn("Wave").find(([, x]) => x.lane === lane);
      const t = Math.floor(r1 * 1001);
      if (w) return { ops: [{ Set: { id: w[0], value: { WavePos: t } } }] };
      return { ops: [{ Create: { id: ids.hex128(), record: { Wave: { scene, lane, t } } } }] };
    }
    case "sceneAdd": {
      if (scenes(records).length >= 12) return;
      const id = ids.hex128();
      const ops: Op[] = [{ Create: { id, record: { Scene: { name: `S ${phrase(r1, 1)}`.slice(0, 24), order: orderKey(r2, r3), clock: null } } } }];
      const slots = live(records, "RosterSlot");
      for (const [slot, s] of slots) {
        const p: PlayerState = {
          scene: id,
          slot,
          pos: { x: -3000 + s.slot * 1200, y: s.team === "Amber" ? -8000 : 8000 },
          alive: true,
          placed: true,
          souls: null,
          ult_cooldown: null,
          visible: true,
        };
        ops.push({ Create: { id: ids.hex128(), record: { PlayerState: p } } });
      }
      return { ops };
    }
    case "sceneReorder": {
      const s = at(scenes(records), r0);
      return s && { ops: [{ Set: { id: s[0], value: { SceneOrder: orderKey(r1, r2) } } }] };
    }
    case "sceneDelete": {
      const all = scenes(records);
      if (all.length < 3) return;
      const s = at(all, r0)!;
      return { ops: [{ Delete: { id: s[0] } }] };
    }
    case "viewerEdit": {
      const p = at(players, r0);
      return p && { ops: [{ Set: { id: p[0], value: { PlayerPos: pos(r1, r2) } } }] };
    }
    case "contest":
      return contest(r, records, ids);
  }
  return undefined;
}

/** Several editors write the same field at once. Targets come from the shared r[0..2] and the
 * first scene in board order, so every contestant aims at the same record. */
function contest(r: number[], records: Records, ids: Rng): Built | undefined {
  const [r0 = 0, , kind = 0, v0 = 0, v1 = 0, v2 = 0] = r;
  const first = scenes(records)[0];
  if (!first) return;
  const scene = first[0];
  const p = at(playersOf(records, scene), r0);
  if (kind < 0.3 && p) return { ops: [{ Set: { id: p[0], value: { PlayerPos: pos(v0, v1) } } }] };
  if (kind < 0.45) return { ops: [{ Set: { id: scene, value: { SceneClock: Math.floor(v0 * 3600) } } }] };
  if (kind < 0.6 && p) return { ops: [{ Set: { id: p[0], value: { PlayerSouls: Math.floor(v0 * 60000) } } }] };
  if (kind < 0.7) {
    const slot = at(live(records, "RosterSlot"), r0);
    return slot && { ops: [{ Set: { id: slot[0], value: { RosterName: `c${Math.floor(v0 * 1e6)}` } } }] };
  }
  if (kind < 0.8) {
    const meta = live(records, "BoardMeta")[0];
    return meta && { ops: [{ Set: { id: meta[0], value: { Title: `Contest ${Math.floor(v0 * 1e6)}` } } }] };
  }
  if (kind < 0.9) {
    // Concurrent first toggles of one objective: all but one create is a Duplicate.
    return build("objective", [r0, 0, 0, 0, 0, 0], records, scene, ids);
  }
  const c = live(records, "Callout").find(([, x]) => x.scene === scene);
  if (c) return { ops: [{ Set: { id: c[0], value: { CalloutText: `mine ${Math.floor(v2 * 1e6)}` } } }] };
  return p && { ops: [{ Set: { id: p[0], value: { PlayerUltCooldown: Math.floor(v0 * 101) } } }] };
}
