// What a build column reads (map-state spec §6): one hero's build at a frame, behind one
// interface with two producers. Player's is computed from the timeline at t, in memos that
// change only when what the column shows does (player/buildState.ts); a scene's is read from
// the snapshot its records hold (build.ts). The column, the top bars and the hero panel take a
// `BuildView` and never the timeline or a scene's records, so a build feature added to the
// interface shows in both.

import { type Accessor, createMemo } from "solid-js";
import type { More } from "../gen/More";
import { type BuildAt, type BuildOrderEntry, buildOrder, killsAt } from "../match/builds";
import { PICKUPS_FORMAT, type StatBuild } from "../match/stats";
import { type Timeline, type TimelinePlayer, scoreboardValueAt } from "../match/timeline";
import { buildState, sameBuild, sameStatBuild } from "../player/buildState";
import { type HeroBuild, readBuild, statOf } from "./build";

export interface BuildView {
  /** The hero the build is of. */
  hero: Accessor<number>;
  /** Items and abilities (null lists: the frame doesn't hold them). */
  build: Accessor<BuildAt>;
  /** The calculator's input; null when the frame can't give one (no level, items or pickups). */
  statInput: Accessor<StatBuild | null>;
  kills: Accessor<number | null>;
  deaths: Accessor<number | null>;
  assists: Accessor<number | null>;
  level: Accessor<number | null>;
  /** The recorded max health (the calculated one replaces it when there is a stat table). */
  maxHealth: Accessor<number | null>;
  /** The match's patch: which tooltips and stat table apply. */
  patch: Accessor<number | undefined>;
  /** The frame's match second: build-order rows after it are yet to come. */
  time: Accessor<number>;
  /** The build order: every row of the match in Player, the rows up to the frame in a scene. */
  order: (components?: (id: number) => number[] | undefined) => BuildOrderEntry[] | null;
  /** Player's alone: the timeline's hero, for what spans the match and isn't in a frame (the
   * active effects), and where the match ends. Absent in a scene. */
  live?: { player: Accessor<TimelinePlayer>; endDs: Accessor<number | undefined> };
}

/** Player's: the hero's build at `t`. While `visible` is false the time holds still, so a hidden
 * column reads nothing per frame (buildState.ts). Call inside a component or root. */
export function playerBuildView(player: Accessor<TimelinePlayer>, tl: Accessor<Timeline | undefined>, t: Accessor<number>, visible: Accessor<boolean> = () => true): BuildView {
  const { build, statInput, time } = buildState(player, t, visible);
  const kills = createMemo(() => (player().kills != null ? scoreboardValueAt(player().kills, time()) : killsAt(tl(), time(), player().team, player().slot)));
  const deaths = createMemo(() => player().deaths.filter((d) => d <= time()).length);
  return {
    hero: () => player().hero_id,
    build,
    // Calculated stats need the statue pickups, which older timelines don't have.
    statInput: () => ((tl()?.format ?? 0) >= PICKUPS_FORMAT ? statInput() : null),
    kills,
    deaths,
    assists: () => scoreboardValueAt(player().assists, time()),
    level: () => scoreboardValueAt(player().level, time()),
    maxHealth: () => scoreboardValueAt(player().max_health, time()),
    patch: () => tl()?.build,
    time,
    order: (components) => buildOrder(player(), components),
    live: { player, endDs: () => (tl() ? tl()!.duration_s * 10 : undefined) },
  };
}

/** What a scene's view is read from: the hero's record and the scene's state. */
export interface SceneBuildSource {
  /** The hero record's `more`. */
  more: Accessor<More | undefined>;
  /** The snapshot's watermark (build.ts `captured`). */
  rows: Accessor<number>;
  /** The hero the slot holds now (the stored one wins while it is there). */
  hero: Accessor<number>;
  alive: Accessor<boolean>;
  patch: Accessor<number | undefined>;
  /** The frame's match second (the scene's `source.t`). */
  time: Accessor<number>;
}

/** A scene's: the build its snapshot holds. Static: it changes only when a record does. */
export function sceneBuildView(src: SceneBuildSource): BuildView {
  const stored = createMemo<HeroBuild>(() => readBuild(src.more(), src.rows(), src.hero()));
  const build = createMemo((): BuildAt => ({ items: stored().items, abilities: stored().abilities }), undefined, { equals: sameBuild });
  const statInput = createMemo(() => statOf(stored(), src.alive()), undefined, { equals: sameStatBuild });
  return {
    hero: () => stored().hero,
    build,
    statInput,
    kills: () => stored().kills,
    deaths: () => stored().deaths,
    assists: () => stored().assists,
    level: () => stored().level,
    maxHealth: () => stored().max_health,
    patch: src.patch,
    time: src.time,
    order: (components) => buildOrder(stored().order ? { items: stored().order! } : {}, components),
  };
}

/** Whether a hero's record holds a build that is still its hero's (spec §5: a slot whose hero
 * changed since doesn't draw the old hero's build). `rows`: the snapshot's watermark. */
export function holdsBuild(more: More | undefined, rows: number, hero: number | null | undefined): boolean {
  if (rows <= 0 || hero == null || typeof more?.hero !== "number") return false;
  return more.hero === hero;
}
