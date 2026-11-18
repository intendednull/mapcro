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
import { type Timeline, clockLabel, slotKey } from "./timeline";
import { LIMITS } from "../gen/limits";
import type { More } from "../gen/More";
import { WRITTEN, captureBuild, captureScene, captured, heroBuildAt, holdsHealth, moreBytes, retakeRows, writesHeroes } from "../mapstate/build";
import { savedPart } from "../mapstate/frame";
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
  const ops: Op[] = [{ Create: { id, record: { Scene: scene } } }];
  // The frame's facts, unfiltered (map-state spec D9): what Player's second's part is built on
  // (mapstate/frame.ts). At a whole second a hero's place and respawn time are its sample's.
  const frame = savedPart(tl, second, markers);
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
    ops.push({ Create: { id: mint(), record } });
  }
  for (const key of frame.down) ops.push({ Create: { id: mint(), record: { ObjectiveState: { scene: id, key, status: "Destroyed" } } } });
  // Only what differs from a new scene's defaults: the rift that's up and the open urn point
  // (both default off), and taken powerups (they default available).
  for (const [key, status] of frame.sites) {
    const off = key.startsWith("rift:") || key.startsWith("urn:");
    if ((off && status === "Active") || (!off && status === "Destroyed")) ops.push({ Create: { id: mint(), record: { ObjectiveState: { scene: id, key, status } } } });
  }
  // A scene has one split per lane: the middle of the zipline colours' gap (spec §6b).
  for (const [lane, w] of frame.lanes) if (lanes.length === 0 || lanes.includes(lane)) ops.push({ Create: { id: mint(), record: { Wave: { scene: id, lane, t: Math.round((w.amber + w.sapphire) / 2) } } } });
  // A scene that holds its own heroes (spec D2) leaves the board's roster alone: no other
  // scene's heroes change. A build from before `has_heroes` was written set the roster to the
  // match's (`written` below the row: tests of that build pass it).
  const written = opts.written ?? WRITTEN;
  const own = writesHeroes(written);
  if (!own && opts.roster !== false) for (const c of rosterChanges(roster, tl)) ops.push({ Set: { id: c.id, value: { RosterHero: c.hero } } });
  // The snapshot (map-state spec §4.4): every hero's build and the scene's state, if the whole
  // save still fits one transaction; else the scene is saved without it, and says nothing of
  // builds (Retake can add them later, in transactions of its own). `builds` tells the caller,
  // which says so ("Saved without builds"): never silent.
  let stored = false;
  let stateId: RecordId | undefined;
  if (opts.builds !== false && ops.length < LIMITS.max_ops_per_tx) {
    stateId = mint();
    const state: Op = { Create: { id: stateId, record: { SceneState: { scene: id, more: captureScene(tl, { written }) } } } };
    const room = LIMITS.max_tx_bytes - TX_SLACK - opsBytes([...ops, state]);
    const builds = sceneBuilds(roster, tl, second, room, opts.source ? opts.source.tier : null);
    if (builds) {
      roster.forEach((s, i) => {
        const more = builds.get(s.id);
        if (more) heroes[i]!.PlayerState.more = more;
      });
      ops.push(state);
      stored = true;
    }
  }
  // Without the builds the scene still holds its heroes: each record its match's hero, and a
  // state that says so. Both or neither, to the byte.
  let held = !own || stored;
  if (!stored && own && ops.length < LIMITS.max_ops_per_tx) {
    const players = new Map(tl.players.map((p) => [slotKey(p.team, p.slot), p]));
    const mine = roster.map((s) => players.get(slotKey(s.slot.team, s.slot.slot))?.hero_id);
    const state: Op = { Create: { id: stateId ?? mint(), record: { SceneState: { scene: id, more: captureScene(tl, { builds: false, written }) } } } };
    const bytes = mine.reduce((n: number, hero) => n + (hero == null ? 0 : MORE_KEY + moreBytes({ hero })), 0);
    if (opsBytes([...ops, state]) + bytes <= LIMITS.max_tx_bytes - TX_SLACK) {
      mine.forEach((hero, i) => {
        if (hero != null) heroes[i]!.PlayerState.more = { hero };
      });
      ops.push(state);
      held = true;
    }
  }
  // No room even for that (the save's own records fill the transaction; not seen on a real
  // match): no scene at all, rather than one that draws the board roster's heroes, which Save
  // no longer sets. `ops` is then empty and the caller says "Not saved".
  if (!held) return { id, ops: [], order, builds: false };
  return { id, ops, order, builds: stored };
}

/** Bytes kept free in a transaction for what wraps its ops on the wire (the client's id, the
 * cseq and kind) and for each `more` key's own punctuation. */
const TX_SLACK = 1024;
/** Ops as the server counts a transaction against `max_tx_bytes`: their JSON, in bytes. */
export const opsBytes = (ops: Op[]) => new TextEncoder().encode(JSON.stringify(ops)).length;

/**
 * Each roster slot's build at `second` of the match, as its hero record's `more`, all within
 * `room` bytes together (each within a record's own cap): the build orders lose their oldest
 * rows to fit. `undefined`: they don't fit even so. `tier`: the scene's `source.tier` (null: none).
 */
function sceneBuilds(roster: Slot[], tl: Timeline, second: number, room: number, tier: string | null): Map<RecordId, More> | undefined {
  const players = new Map(tl.players.map((p) => [slotKey(p.team, p.slot), p]));
  const mine = roster.flatMap((s) => {
    const p = players.get(slotKey(s.slot.team, s.slot.slot));
    return p ? [{ id: s.id, build: heroBuildAt(tl, p, second, tier) }] : [];
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
 * snapshot, or one from before rows this build writes. A scene saved from the replay is retaken
 * from the replay only: it reads its heroes' health as captured (`holdsHealth`), and the
 * metadata tier has none to give. */
export function canRetake(scene: Pick<SceneRow["scene"], "source">, state: More | undefined, tl: Pick<Timeline, "match_id" | "tier"> | undefined, written: number = WRITTEN): boolean {
  if (!tl || scene.source?.match_id !== tl.match_id || !retakesFrom(scene.source.tier, tl)) return false;
  const c = captured(state);
  return !c.builds || c.rows < retakeRows(written);
}

/**
 * Retake (map-state spec §2 D10, §4.4): what a scene saved from this match didn't capture, from
 * its own moment (`source.t`) of the open match. Every write is a `SetIf` on a value that is
 * absent (or, for the watermark, on the one read), so nothing a person set since is overwritten,
 * and two people retaking at once write the same. Chunked by bytes: more than one transaction,
 * and so more than one undo step, when the builds are large.
 *
 * The one write that isn't a `SetIf`: in a scene that holds its own heroes, a record given a
 * build is also given the hero it belongs to, in the same transaction. A pick another editor
 * sent at the same moment isn't visible here, and a `SetIf` can only test the key it writes, so
 * nothing can make the build's rows wait on the record's `hero`. Writing the two together keeps
 * them together: whichever of the pick and the Retake the server takes last decides the slot,
 * whole (TD-119).
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
  written: number = WRITTEN,
): Op[][] {
  const second = scene.scene.source?.t;
  const tier = scene.scene.source?.tier ?? null;
  if (second == null || !retakesFrom(tier, tl)) return [];
  const players = new Map(tl.players.map((p) => [slotKey(p.team, p.slot), p]));
  const slots = new Map(roster.map((s) => [s.id, s]));
  const absent = (id: RecordId, key: string, value: MoreValue): Op => ({ SetIf: { id, expect: { More: { key, value: null } }, value: { More: { key, value } } } });
  const groups: Op[][] = [];
  const own = captured(state?.more).heroes;
  for (const h of heroes) {
    const s = slots.get(h.state.slot);
    const p = s && players.get(slotKey(s.slot.team, s.slot.slot));
    if (!p) continue;
    const have = h.state.more ?? {};
    // A slot given another hero in a scene that holds its heroes: the match's build is not
    // that hero's, and stays out.
    if (typeof have.hero === "number" && have.hero !== p.hero_id) continue;
    const ops = Object.entries(captureBuild(heroBuildAt(tl, p, second, tier))).filter(([key]) => have[key] === undefined && !(own && key === "hero")).map(([key, value]) => absent(h.id, key, value));
    if (own && (ops.length || have.hero === undefined)) ops.unshift({ Set: { id: h.id, value: { More: { key: "hero", value: p.hero_id } } } });
    if (ops.length) groups.push(ops);
  }
  // The scene's state last, so a scene never says it holds builds that haven't been written.
  // Never `has_heroes`: a scene saved before it draws the board roster's heroes, and stays so.
  const want = captureScene(tl, { heroes: false, written });
  if (!state) groups.push([{ Create: { id: mint(), record: { SceneState: { scene: scene.id, more: want } } } }]);
  else {
    const have = state.more ?? {};
    const ops = Object.entries(want).filter(([key]) => have[key] === undefined).map(([key, value]) => absent(state.id, key, value));
    // The watermark moves up from the value read, never down.
    const rows = captured(have).rows;
    if (have.rows !== undefined && rows < written) ops.push({ SetIf: { id: state.id, expect: { More: { key: "rows", value: have.rows! } }, value: { More: { key: "rows", value: written } } } });
    if (ops.length) groups.push(ops);
  }
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
