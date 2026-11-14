// Save as scene's snapshot and Retake (map-state spec §4.4, phase 2): what is written, that it
// fits a transaction, and that Retake only fills what is absent. A made-up match (no names, no
// ids; 6v6).
import { describe, expect, it } from "vitest";
import type { Op } from "../src/gen/Op";
import type { More } from "../src/gen/More";
import type { PlayerState } from "../src/gen/PlayerState";
import { LIMITS } from "../src/gen/limits";
import { ROWS } from "../src/gen/rows";
import { WRITTEN, captureBuild, captureScene, captured, heroBuildAt, readBuild } from "../src/mapstate/build";
import { holdsBuild } from "../src/mapstate/buildView";
import { canRetake, chunkByBytes, matchSceneOps, matchScenesOps, opsBytes, retakeOps, sourceOf } from "../src/match/save";
import { PICKUPS_FORMAT } from "../src/match/stats";
import type { Timeline, TimelinePlayer } from "../src/match/timeline";

/** When the long match's buys happen (tenths), and a frame after them all (seconds). */
const LATE_DS = 100_000;
const LATE_T = 20_000;
const hero = (team: "amber" | "sapphire", slot: number, buys = 3): TimelinePlayer => {
  const i = (team === "amber" ? 0 : 6) + slot;
  return {
    team, slot, hero_id: 10 + i, name: "",
    x: [0, 1, 2, 3, 4], y: [0, 1, 2, 3, 4], health: [100, 90, 60, 75, 100], deaths: [],
    souls: [[0, 400]], ult: [null, 100, 50, 25, 0],
    level: [[0, 1], [2, 4 + i]], max_health: [[0, 700]], kills: [[0, i]], assists: [[0, 2]],
    pickups: [[1, [20, 1, 2, 3, 4]]],
    items: Array.from({ length: buys }, (_, k) => [buys > 3 ? LATE_DS + k : k, 4_000_000_000 + 1000 * i + k, 0] as [number, number, number]),
    abilities: [[0, 7000 + i, 1], [2, 7000 + i, 3]], casts: [], charges: [], stacks: [],
  } as TimelinePlayer;
};
const match = (buys = 3): Timeline => ({
  match_id: 9, start_time: 0, duration_s: 4, source: "replay", tier: "replay", build: 6839, format: PICKUPS_FORMAT, reanchored: 0,
  players: (["amber", "sapphire"] as const).flatMap((team) => [0, 1, 2, 3, 4, 5].map((slot) => hero(team, slot, buys))),
  objectives: [], mid_boss: [],
} as unknown as Timeline);

const tl = match();
const roster = tl.players.map((p, i) => ({ id: `slot-${i}`, slot: { team: p.team === "amber" ? ("Amber" as const) : ("Sapphire" as const), slot: p.slot, hero: p.hero_id, name: "" } }));
const minter = () => {
  let n = 0;
  return () => `id${n++}`;
};
const save = (m: Timeline, opts = {}, t = 2, markers: never[] = []) => matchSceneOps(roster as never, [], undefined, m, t, markers, minter(), [], { source: sourceOf(m), ...opts });
/** A long match late on: every hero with a full build order and inventory, and seventy
 * objectives down, so a save's records alone are a good part of a transaction. */
const late = () => {
  const keys = Array.from({ length: 70 }, (_, k) => `walker:amber:lane1:${k}`);
  const tl = { ...match(200), objectives: keys.map((key) => ({ key, kind: "walker", team: "amber", lane: 1, destroyed_s: 5 })) } as unknown as Timeline;
  const markers = keys.map((key) => ({ key, kind: "walker", team: "amber", lane: "yellow", at: { x: 0, y: 0 } })) as never[];
  return { tl, markers };
};
const heroesOf = (ops: Op[]) => ops.flatMap((o) => ("Create" in o && "PlayerState" in o.Create.record ? [{ id: o.Create.id, state: o.Create.record.PlayerState as PlayerState }] : []));
const stateOf = (ops: Op[]) => ops.flatMap((o) => ("Create" in o && "SceneState" in o.Create.record ? [{ id: o.Create.id, more: o.Create.record.SceneState.more }] : []));

describe("Save as scene's snapshot", () => {
  it("stores every hero's build and the scene's state, in the save's one transaction", () => {
    const { id, ops } = save(tl);
    const heroes = heroesOf(ops);
    expect(heroes).toHaveLength(12);
    heroes.forEach((h, i) => {
      expect(h.state.more).toEqual(captureBuild(heroBuildAt(tl, tl.players[i]!, 2)));
      // The hero it is a build of: a scene draws it only while the slot still holds that hero.
      expect(h.state.more!.hero).toBe(tl.players[i]!.hero_id);
      expect(holdsBuild(h.state.more, WRITTEN, tl.players[i]!.hero_id)).toBe(true);
      expect(holdsBuild(h.state.more, WRITTEN, 999)).toBe(false);
    });
    const state = stateOf(ops);
    expect(state).toHaveLength(1);
    expect(state[0]!.more).toEqual(captureScene(tl));
    expect(ops.filter((o) => "Create" in o && "SceneState" in o.Create.record && o.Create.record.SceneState.scene === id)).toHaveLength(1);
    expect(ops.length).toBeLessThanOrEqual(LIMITS.max_ops_per_tx);
    expect(opsBytes(ops)).toBeLessThan(LIMITS.max_tx_bytes - 512);
  });

  it("without builds is the save as it was: no `more`, no state", () => {
    const { ops } = save(tl, { builds: false });
    expect(heroesOf(ops).every((h) => h.state.more === undefined)).toBe(true);
    expect(stateOf(ops)).toHaveLength(0);
    // And the snapshot adds to it, changing nothing else.
    const strip = (list: Op[]) => list.filter((o) => !("Create" in o && "SceneState" in o.Create.record)).map((o) => JSON.parse(JSON.stringify(o, (k, v) => (k === "more" ? undefined : v))));
    expect(strip(save(tl).ops)).toEqual(strip(ops));
  });

  it("a slot the match has no hero for gets no build", () => {
    const short = { ...tl, players: tl.players.slice(0, 11) } as Timeline;
    const heroes = heroesOf(save(short).ops);
    expect(heroes[11]!.state.more).toBeUndefined();
    expect(heroes[10]!.state.more).toBeDefined();
    expect(holdsBuild(undefined, WRITTEN, 21)).toBe(false);
    expect(holdsBuild({ hero: 21 }, 0, 21)).toBe(false);
    expect(holdsBuild({ hero: 21 }, WRITTEN, null)).toBe(false);
  });

  it("long build orders lose their oldest rows so the save still fits one transaction", () => {
    const { tl: long, markers } = late();
    // Whole, the twelve builds and the save's records are over a transaction.
    const whole = long.players.reduce((n, p) => n + JSON.stringify(captureBuild(heroBuildAt(long, p, LATE_T))).length, 0);
    expect(whole + opsBytes(save(long, { builds: false }, LATE_T, markers).ops)).toBeGreaterThan(LIMITS.max_tx_bytes);
    const { ops } = save(long, {}, LATE_T, markers);
    expect(opsBytes(ops)).toBeLessThanOrEqual(LIMITS.max_tx_bytes - 1024);
    expect(ops.length).toBeLessThanOrEqual(LIMITS.max_ops_per_tx);
    const heroes = heroesOf(ops);
    expect(stateOf(ops)).toHaveLength(1);
    for (const [i, h] of heroes.entries()) {
      const order = h.state.more!.build_order as number[];
      expect(order.length % 3).toBe(0);
      expect(order.length).toBeGreaterThan(0);
      expect(order.length).toBeLessThan(200 * 3);
      // The latest rows are the ones kept, and the items are whole.
      expect(order.slice(-3)).toEqual([LATE_DS + 199, 4_000_000_000 + 1000 * i + 199, 0]);
      expect(readBuild(h.state.more, WRITTEN, 0).items).toEqual(heroBuildAt(long, long.players[i]!, LATE_T).items!.slice(0, 32));
    }
  });

  it("says when the snapshot has no room in the transaction, and saves the scene without it", () => {
    expect(save(tl).builds).toBe(true);
    expect(save(tl, { builds: false }).builds).toBe(false);
    // The save's own records nearly fill a transaction: 230 objectives down, with long keys.
    const keys = Array.from({ length: 230 }, (_, k) => `walker:amber:lane1:${k}:${"k".repeat(120)}`);
    const full = { ...match(200), objectives: keys.map((key) => ({ key, kind: "walker", team: "amber", lane: 1, destroyed_s: 5 })) } as unknown as Timeline;
    const markers = keys.map((key) => ({ key, kind: "walker", team: "amber", lane: "yellow", at: { x: 0, y: 0 } })) as never[];
    const bare = save(full, {}, LATE_T, markers);
    expect(bare.builds).toBe(false);
    expect(bare.ops).toEqual(save(full, { builds: false }, LATE_T, markers).ops);
    expect(stateOf(bare.ops)).toHaveLength(0);
    expect(heroesOf(bare.ops).every((h) => h.state.more === undefined)).toBe(true);
    expect(opsBytes(bare.ops)).toBeLessThanOrEqual(LIMITS.max_tx_bytes - 1024);
    // Many scenes: each says for itself.
    expect(matchScenesOps(roster as never, [], undefined, full, [{ t: 1, name: "a" }, { t: LATE_T, name: "b" }], markers, minter(), []).builds).toEqual([true, false]);
  });

  it("many scenes are chunked by bytes, a scene never split", () => {
    const long = match(150);
    const moments = [1, 2, 3, 4].map((t) => ({ t: LATE_T + t, name: `m${t}` }));
    const { groups } = matchScenesOps(roster as never, [], undefined, long, moments, [], minter(), []);
    const txs = chunkByBytes(groups);
    expect(txs.flat()).toEqual(groups.flat());
    expect(txs.length).toBeGreaterThan(1);
    for (const tx of txs) {
      expect(opsBytes(tx)).toBeLessThanOrEqual(LIMITS.max_tx_bytes - 1024);
      expect(tx.length).toBeLessThanOrEqual(LIMITS.max_ops_per_tx);
      // Whole scenes: as many states as scenes.
      const scenes = tx.filter((o) => "Create" in o && "Scene" in o.Create.record).length;
      expect(stateOf(tx)).toHaveLength(scenes);
    }
    // Small scenes share a transaction, within the op cap.
    const small = matchScenesOps(roster as never, [], undefined, tl, [1, 2, 3, 4].map((t) => ({ t, name: `m${t}` })), [], minter(), []).groups;
    expect(chunkByBytes(small)).toHaveLength(1);
    expect(chunkByBytes(Array.from({ length: 30 }, () => small[0]!)).every((tx) => tx.length <= LIMITS.max_ops_per_tx)).toBe(true);
  });
});

describe("Retake", () => {
  const scene = (t: number | null, match_id = 9) => ({ id: "scene", scene: { name: "s", order: "a", clock: t, source: t == null ? null : { match_id, t, tier: "replay" } } }) as never;
  const old = () => heroesOf(save(tl, { builds: false }).ops);
  const setIf = (o: Op) => ("SetIf" in o ? o.SetIf : undefined);

  it("is offered for a scene of the open match that holds no builds, or older rows", () => {
    expect(canRetake({ source: { match_id: 9, t: 2, tier: "replay" } }, undefined, tl)).toBe(true);
    expect(canRetake({ source: { match_id: 9, t: 2, tier: "replay" } }, captureScene(tl), tl)).toBe(false);
    expect(canRetake({ source: { match_id: 9, t: 2, tier: "replay" } }, { ...captureScene(tl), rows: WRITTEN - 1 }, tl)).toBe(true);
    expect(canRetake({ source: { match_id: 8, t: 2, tier: "replay" } }, undefined, tl)).toBe(false);
    expect(canRetake({}, undefined, tl)).toBe(false);
    expect(canRetake({ source: { match_id: 9, t: 2, tier: "replay" } }, undefined, undefined)).toBe(false);
  });

  it("gives an old scene its builds from its own moment, each value only where none is, the state last", () => {
    const heroes = old();
    const txs = retakeOps(scene(2), undefined, heroes, roster as never, tl, minter());
    const ops = txs.flat();
    const last = ops.at(-1)!;
    expect("Create" in last && "SceneState" in last.Create.record && last.Create.record.SceneState).toEqual({ scene: "scene", more: captureScene(tl) });
    expect(ops.slice(0, -1).every((o) => setIf(o) && "More" in setIf(o)!.expect && (setIf(o)!.expect as { More: { value: unknown } }).More.value === null)).toBe(true);
    // What it writes for a hero is what Save would have stored.
    heroes.forEach((h, i) => {
      const written: More = {};
      for (const o of ops) {
        const s = setIf(o);
        if (s && s.id === h.id && "More" in s.value) written[s.value.More.key] = s.value.More.value as never;
      }
      expect(written).toEqual(captureBuild(heroBuildAt(tl, tl.players[i]!, 2)));
    });
    for (const tx of txs) {
      expect(opsBytes(tx)).toBeLessThanOrEqual(LIMITS.max_tx_bytes - 1024);
      expect(tx.length).toBeLessThanOrEqual(LIMITS.max_ops_per_tx);
    }
    // Its own moment, not the playback's: second 0 has no level-up yet.
    const early = retakeOps(scene(0), undefined, heroes, roster as never, tl, minter()).flat();
    const level = early.map(setIf).find((s) => s && s.id === heroes[0]!.id && "More" in s.value && s.value.More.key === "level");
    expect(level && "More" in level.value && level.value.More.value).toBe(1);
  });

  it("large builds take more than one transaction, the state in the last", () => {
    const txs = retakeOps(scene(LATE_T), undefined, old(), roster as never, match(200), minter());
    expect(txs.length).toBeGreaterThan(1);
    expect(stateOf(txs.at(-1)!)).toHaveLength(1);
    expect(txs.slice(0, -1).every((tx) => stateOf(tx).length === 0)).toBe(true);
    for (const tx of txs) expect(opsBytes(tx)).toBeLessThanOrEqual(LIMITS.max_tx_bytes - 1024);
  });

  it("writes only what is absent, and moves an older watermark up", () => {
    const heroes = heroesOf(save(tl).ops);
    // A snapshot from before `level` was a row, with one hero's items edited since.
    const rows = ROWS.level.index;
    const state = { id: "state", more: { ...captureScene(tl), rows } as More };
    const partial = heroes.map((h) => ({ id: h.id, state: { ...h.state, more: Object.fromEntries(Object.entries(h.state.more!).filter(([k]) => ROWS[k as keyof typeof ROWS].index < rows)) } }));
    const ops = retakeOps(scene(2), state, partial, roster as never, tl, minter()).flat();
    const keys = new Set(ops.flatMap((o) => (setIf(o) && setIf(o)!.id !== "state" && "More" in setIf(o)!.value ? [(setIf(o)!.value as { More: { key: string } }).More.key] : [])));
    expect([...keys].sort()).toEqual(Object.keys(ROWS).filter((k) => ROWS[k as keyof typeof ROWS].entity === "hero" && ROWS[k as keyof typeof ROWS].index >= rows && ROWS[k as keyof typeof ROWS].index < WRITTEN && k in captureBuild(heroBuildAt(tl, tl.players[0]!, 2))).sort());
    // The watermark: from the value read to this build's, and nothing else of the state.
    expect(ops.filter((o) => setIf(o)?.id === "state")).toEqual([{ SetIf: { id: "state", expect: { More: { key: "rows", value: rows } }, value: { More: { key: "rows", value: WRITTEN } } } }]);
    expect(captured({ ...state.more, rows: WRITTEN }).builds).toBe(true);
    // Nothing to do on a scene that holds it all, or one with no moment.
    expect(retakeOps(scene(2), { id: "state", more: captureScene(tl) }, heroes, roster as never, tl, minter())).toEqual([]);
    expect(retakeOps(scene(null), undefined, heroes, roster as never, tl, minter())).toEqual([]);
  });
});
