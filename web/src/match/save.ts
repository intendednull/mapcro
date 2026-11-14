// "Save as scene" from a match moment: one transaction that adds a frozen scene after the
// current one (players, souls and objectives as at t; clock = t; from a replay also ult
// cooldowns, the rift that's up, taken powerups and lane-wave splits) and, if the board's
// heroes differ from the match's, sets the roster to the match's heroes, slot by slot.
// The scene is also a snapshot of the frame (docs/specs/map-state.md): each hero's record holds
// its build (mapstate/build.ts) and the scene's state says so, in the same transaction. Retake
// gives an older scene the same, from its own moment of the open match.

import { keyBetween } from "../core/order";
import type { Op } from "../gen/Op";
import type { RecordId } from "../gen/RecordId";
import type { MoreValue } from "../gen/MoreValue";
import type { PlayerState } from "../gen/PlayerState";
import type { Marker } from "../map/model";
import type { Slot } from "../board/state";
import type { SceneRow } from "../board/scenes";
import { clampToMap } from "../map/transform";
import { type Timeline, clockLabel, downAt, lanesAt, playersAt, sitesAt } from "./timeline";
import { LIMITS } from "../gen/limits";
import type { More } from "../gen/More";
import { WRITTEN, captureBuild, captureScene, captured, heroBuildAt, moreBytes } from "../mapstate/build";
import type { Player } from "../board/state";

export const slotKey = (team: string, slot: number) => `${team === "Amber" || team === "amber" ? "amber" : "sapphire"}-${slot}`;

/** Roster slots whose hero differs from the match's (the "Roster → match heroes" change). */
export function rosterChanges(roster: Slot[], tl: Timeline): Array<{ id: RecordId; hero: number }> {
  const byKey = new Map(tl.players.map((p) => [slotKey(p.team, p.slot), p.hero_id]));
  return roster.flatMap((s) => {
    const hero = byKey.get(slotKey(s.slot.team, s.slot.slot));
    return hero !== undefined && s.slot.hero !== hero ? [{ id: s.id, hero }] : [];
  });
}

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
): { id: RecordId; ops: Op[]; order: string } {
  const i = current ? scenes.findIndex((s) => s.id === current.id) : scenes.length - 1;
  const id = mint();
  const second = Math.floor(t);
  const order = keyBetween(opts.after ?? scenes[i]?.scene.order, scenes[i + 1]?.scene.order);
  const name = opts.name ?? "Match moment";
  const scene = { name: sceneName(name, second), order, clock: second, ...(opts.source ? { source: { ...opts.source, t: second } } : {}) };
  const ops: Op[] = [{ Create: { id, record: { Scene: scene } } }];
  const at = new Map(playersAt(tl, second).map((p) => [slotKey(p.team, p.slot), p]));
  const heroes: Array<{ PlayerState: PlayerState }> = [];
  for (const s of roster) {
    const p = at.get(slotKey(s.slot.team, s.slot.slot));
    const where = p?.pos ?? p?.last;
    const pos = where ? clampToMap({ x: where.x, y: where.y }) : { x: 0, y: 0 };
    const record = { PlayerState: { scene: id, slot: s.id, pos, alive: p ? p.pos !== null : true, placed: !!where, souls: p?.souls ?? null, ult_cooldown: p?.ult ?? null, visible: true } as PlayerState };
    heroes.push(record);
    ops.push({ Create: { id: mint(), record } });
  }
  for (const key of downAt(tl, second, markers)) ops.push({ Create: { id: mint(), record: { ObjectiveState: { scene: id, key, status: "Destroyed" } } } });
  // Only what differs from a new scene's defaults: the rift that's up and the open urn point
  // (both default off), and taken powerups (they default available).
  for (const [key, status] of sitesAt(tl, second, markers)) {
    const off = key.startsWith("rift:") || key.startsWith("urn:");
    if ((off && status === "Active") || (!off && status === "Destroyed")) ops.push({ Create: { id: mint(), record: { ObjectiveState: { scene: id, key, status } } } });
  }
  // A scene has one split per lane: the middle of the zipline colours' gap (spec §6b).
  for (const [lane, w] of lanesAt(tl, second)) if (lanes.length === 0 || lanes.includes(lane)) ops.push({ Create: { id: mint(), record: { Wave: { scene: id, lane, t: Math.round((w.amber + w.sapphire) / 2) } } } });
  if (opts.roster !== false) for (const c of rosterChanges(roster, tl)) ops.push({ Set: { id: c.id, value: { RosterHero: c.hero } } });
  // The snapshot (map-state spec §4.4): every hero's build and the scene's state, if the whole
  // save still fits one transaction; else the scene is saved without it, and says nothing of
  // builds (Retake can add them later, in transactions of its own).
  if (opts.builds !== false && ops.length < LIMITS.max_ops_per_tx) {
    const state: Op = { Create: { id: mint(), record: { SceneState: { scene: id, more: captureScene(tl) } } } };
    const room = LIMITS.max_tx_bytes - TX_SLACK - opsBytes([...ops, state]);
    const builds = sceneBuilds(roster, tl, second, room);
    if (builds) {
      roster.forEach((s, i) => {
        const more = builds.get(s.id);
        if (more) heroes[i]!.PlayerState.more = more;
      });
      ops.push(state);
    }
  }
  return { id, ops, order };
}

/** Bytes kept free in a transaction for what wraps its ops on the wire (the client's id, the
 * cseq and kind) and for each `more` key's own punctuation. */
const TX_SLACK = 1024;
/** Ops as the server counts a transaction against `max_tx_bytes`: their JSON, in bytes. */
export const opsBytes = (ops: Op[]) => new TextEncoder().encode(JSON.stringify(ops)).length;

/**
 * Each roster slot's build at `second` of the match, as its hero record's `more`, all within
 * `room` bytes together (each within a record's own cap): the build orders lose their oldest
 * rows to fit. `undefined`: they don't fit even so.
 */
function sceneBuilds(roster: Slot[], tl: Timeline, second: number, room: number): Map<RecordId, More> | undefined {
  const players = new Map(tl.players.map((p) => [slotKey(p.team, p.slot), p]));
  const mine = roster.flatMap((s) => {
    const p = players.get(slotKey(s.slot.team, s.slot.slot));
    return p ? [{ id: s.id, build: heroBuildAt(tl, p, second) }] : [];
  });
  const out = new Map<RecordId, More>();
  // Whole first; over, an even share each.
  for (const share of [LIMITS.max_more_bytes, Math.floor(room / Math.max(1, mine.length))]) {
    out.clear();
    let bytes = 0;
    for (const m of mine) {
      const more = captureBuild(m.build, share);
      bytes += moreBytes(more) + MORE_KEY;
      out.set(m.id, more);
    }
    if (bytes <= room) return out;
  }
  return undefined;
}
/** `,"more":` on a record. */
const MORE_KEY = 8;

/** Whether Retake has anything to give a scene: it came from `tl`'s match, and holds no build
 * snapshot, or one from before rows this build writes. */
export function canRetake(scene: Pick<SceneRow["scene"], "source">, state: More | undefined, tl: Pick<Timeline, "match_id"> | undefined): boolean {
  if (!tl || scene.source?.match_id !== tl.match_id) return false;
  const c = captured(state);
  return !c.builds || c.rows < WRITTEN;
}

/**
 * Retake (map-state spec §2 D10, §4.4): what a scene saved from this match didn't capture, from
 * its own moment (`source.t`) of the open match. Every write is a `SetIf` on a value that is
 * absent (or, for the watermark, on the one read), so nothing a person set since is overwritten,
 * and two people retaking at once write the same. Chunked by bytes: more than one transaction,
 * and so more than one undo step, when the builds are large.
 *
 * `state`: the scene's `SceneState`, if it has one. `heroes`: the scene's hero records.
 */
export function retakeOps(
  scene: SceneRow,
  state: { id: RecordId; more: More | undefined } | undefined,
  heroes: Player[],
  roster: Slot[],
  tl: Timeline,
  mint: () => RecordId,
): Op[][] {
  const second = scene.scene.source?.t;
  if (second == null) return [];
  const players = new Map(tl.players.map((p) => [slotKey(p.team, p.slot), p]));
  const slots = new Map(roster.map((s) => [s.id, s]));
  const absent = (id: RecordId, key: string, value: MoreValue): Op => ({ SetIf: { id, expect: { More: { key, value: null } }, value: { More: { key, value } } } });
  const groups: Op[][] = [];
  for (const h of heroes) {
    const s = slots.get(h.state.slot);
    const p = s && players.get(slotKey(s.slot.team, s.slot.slot));
    if (!p) continue;
    const have = h.state.more ?? {};
    const ops = Object.entries(captureBuild(heroBuildAt(tl, p, second))).filter(([key]) => have[key] === undefined).map(([key, value]) => absent(h.id, key, value));
    if (ops.length) groups.push(ops);
  }
  // The scene's state last, so a scene never says it holds builds that haven't been written.
  const want = captureScene(tl);
  if (!state) groups.push([{ Create: { id: mint(), record: { SceneState: { scene: scene.id, more: want } } } }]);
  else {
    const have = state.more ?? {};
    const ops = Object.entries(want).filter(([key]) => have[key] === undefined).map(([key, value]) => absent(state.id, key, value));
    // The watermark moves up from the value read, never down.
    const rows = captured(have).rows;
    if (have.rows !== undefined && rows < WRITTEN) ops.push({ SetIf: { id: state.id, expect: { More: { key: "rows", value: have.rows! } }, value: { More: { key: "rows", value: WRITTEN } } } });
    if (ops.length) groups.push(ops);
  }
  return chunkByBytes(groups);
}

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
  /** Set the roster to the match's heroes (default true). */
  roster?: boolean;
  /** Where the scene came from (spec §6b): stored for "resume from here". */
  source?: { match_id: number; tier: string };
  /** Store the frame's builds with the scene (default true). */
  builds?: boolean;
}

/**
 * A scene's name from a match: the event alone ("Mirage died"), the clock and the ▶ chip carry
 * the time (operator, 2026-11-08); within the schema's 24 characters.
 */
export function sceneName(label: string, _second?: number): string {
  return label.length > LIMITS.max_name ? `${label.slice(0, LIMITS.max_name - 1)}…` : label;
}

/**
 * One scene per moment, in order after the current scene: the roster is set to the match's
 * heroes once. `groups` holds each scene's ops, to be sent in transactions within the op cap.
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
): { ids: RecordId[]; ops: Op[]; groups: Op[][] } {
  const ids: RecordId[] = [];
  const groups: Op[][] = [];
  let after: string | undefined;
  moments.forEach((m, n) => {
    const r = matchSceneOps(roster, scenes, current, tl, m.t, markers, mint, lanes, { name: m.name, ...(after ? { after } : {}), roster: n === 0, source: sourceOf(tl) });
    ids.push(r.id);
    groups.push(r.ops);
    after = r.order;
  });
  return { ids, ops: groups.flat(), groups };
}

/** A timeline's scene source (spec §6b). */
export const sourceOf = (tl: Timeline) => ({ match_id: tl.match_id, tier: tl.tier === "replay" ? "replay" : "metadata" });
