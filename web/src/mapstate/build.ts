// A hero's build at one frame (map-state spec §3, §6; phase 2, the tracer): what the build
// column shows, as one plain value with two producers. Player computes it from the timeline
// (`heroBuildAt`); a scene stores it in the hero's record (`captureBuild` writes the registry
// rows, `readBuild` reads them back). `fromScene(capture(fromTimeline(t)))` gives the same
// build: test/map-state-build.test.ts holds that for every row.
//
// The list rows are packed here, because the server checks only a list's length and range
// (spec §4.3): each has its stride, and a list that isn't whole strides reads as not captured.

import { LIMITS } from "../gen/limits";
import type { More } from "../gen/More";
import type { MoreValue } from "../gen/MoreValue";
import { ROWS, type RowKey } from "../gen/rows";
import { type AbilityBuildEntry, type BuildAt, type BuildEntry, buildAt, killsAt } from "../match/builds";
import { PICKUPS_FORMAT, type StatBuild } from "../match/stats";
import { type Timeline, type TimelinePlayer, scoreboardValueAt } from "../match/timeline";

/** One row of the timeline's `items` series: `[tenths of a second, item id, kind]`. */
export type OrderRow = [number, number, number];
export type Pickups = [number, number, number, number, number];

export interface HeroBuild {
  /** Whose build it is: a scene draws it only while the slot still holds this hero (spec §5). */
  hero: number;
  /** null: unavailable in the match's tier. */
  items: BuildEntry[] | null;
  abilities: AbilityBuildEntry[] | null;
  /** The buys, sales and upgrades up to the frame, earliest first (match/builds.ts `buildOrder`). */
  order: OrderRow[] | null;
  level: number | null;
  /** Percent of max health; null when dead or unknown. */
  health: number | null;
  /** The statue pickups so far; null when the match's format has none (no calculated stats). */
  pickups: Pickups | null;
  kills: number | null;
  deaths: number | null;
  assists: number | null;
  /** The recorded max health (the calculated one replaces it when there is a stat table). */
  max_health: number | null;
}

type Row = (typeof ROWS)[RowKey];
type HeroKey = { [K in RowKey]: (typeof ROWS)[K]["entity"] extends "hero" ? K : never }[RowKey];
type SceneKey = { [K in RowKey]: (typeof ROWS)[K]["entity"] extends "scene" ? K : never }[RowKey];

/** The registry's length as far as this build writes it: the rows before the first one still
 * `ahead` (rows go live in order). A snapshot stores it as its watermark (`rows`, spec §4.5):
 * a row at or above it was not captured, whatever a later build knows. */
export const WRITTEN: number = (() => {
  const rows = Object.values(ROWS) as Row[];
  const ahead = rows.filter((r) => r.status === "ahead").map((r) => r.index);
  return ahead.length ? Math.min(...ahead) : rows.length;
})();

const ITEM = 4; // id, cooldown (tenths; -1 none), charges (-1 none), stacks (-1 none)
const ABILITY = 5; // id, level, then as an item
const ORDER = 3; // tenths of a second, id, kind
const PICKUP = 100; // a pickup value is stored in hundredths

const lenOf = (key: RowKey) => { const r = ROWS[key]; return r.kind === "ints" ? r.len : 0; };
const or = (n: number | null) => (n == null ? -1 : n);
const un = (n: number) => (n < 0 ? null : n);
const tenths = (s: number | null) => (s == null ? -1 : Math.round(s * 10));
const seconds = (ds: number) => (ds < 0 ? null : ds / 10);
/** `list` as whole rows of `stride`, or null if it isn't (a hand-made or damaged value). */
const strides = (list: unknown, stride: number): number[][] | null => {
  if (!Array.isArray(list) || list.length % stride !== 0 || !list.every((n) => Number.isInteger(n))) return null;
  return Array.from({ length: list.length / stride }, (_, i) => (list as number[]).slice(i * stride, (i + 1) * stride));
};
const int = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) ? v : null);
const inRow = (key: RowKey, n: number | null): n is number => {
  const r = ROWS[key];
  return n != null && Number.isInteger(n) && r.kind === "int" && n >= r.min && n <= r.max;
};

/** Each hero row's value from a build (`undefined`: nothing to store) and back. Every key is
 * required: a row without a producer and a reader doesn't compile (spec §6). */
const HERO: { [K in HeroKey]-?: { put: (b: HeroBuild) => MoreValue | undefined; get: (b: HeroBuild, v: MoreValue | undefined) => void } } = {
  hero: { put: (b) => b.hero, get: (b, v) => { b.hero = int(v) ?? b.hero; } },
  // A match's names are never stored (spec §2, D1); the scene's own name is an edit (phase 6).
  name: { put: () => undefined, get: () => {} },
  items: {
    put: (b) => b.items?.slice(0, lenOf("items") / ITEM).flatMap((e) => [e.id, tenths(e.cooldown), or(e.charges), or(e.stacks)]),
    get: (b, v) => { b.items = strides(v, ITEM)?.map(([id, cd, ch, st]) => ({ id: id!, cooldown: seconds(cd!), charges: un(ch!), stacks: un(st!) })) ?? null; },
  },
  abilities: {
    put: (b) => b.abilities?.slice(0, Math.floor(lenOf("abilities") / ABILITY)).flatMap((e) => [e.id, e.level, tenths(e.cooldown), or(e.charges), or(e.stacks)]),
    get: (b, v) => { b.abilities = strides(v, ABILITY)?.map(([id, level, cd, ch, st]) => ({ id: id!, level: level!, cooldown: seconds(cd!), charges: un(ch!), stacks: un(st!) })) ?? null; },
  },
  // The latest rows when a match has more than the row holds.
  build_order: { put: (b) => b.order?.slice(-lenOf("build_order") / ORDER).flat(), get: (b, v) => { b.order = (strides(v, ORDER) as OrderRow[] | null) ?? null; } },
  level: { put: (b) => (inRow("level", b.level) ? b.level : undefined), get: (b, v) => { b.level = int(v); } },
  health: { put: (b) => (b.health == null ? undefined : Math.max(0, Math.min(100, Math.round(b.health)))), get: (b, v) => { b.health = int(v); } },
  // Hundredths: the timeline's values are f32 and the resists move in quarters (a whole number
  // lost up to 0.5 on most frames). Permanent once written, like every packing here.
  pickups: {
    put: (b) => b.pickups?.map((n) => Math.round(n * PICKUP)),
    get: (b, v) => { const p = strides(v, 5); b.pickups = p?.length === 1 ? (p[0]!.map((n) => n / PICKUP) as Pickups) : null; },
  },
  kills: { put: (b) => (inRow("kills", b.kills) ? b.kills : undefined), get: (b, v) => { b.kills = int(v); } },
  deaths: { put: (b) => (inRow("deaths", b.deaths) ? b.deaths : undefined), get: (b, v) => { b.deaths = int(v); } },
  assists: { put: (b) => (inRow("assists", b.assists) ? b.assists : undefined), get: (b, v) => { b.assists = int(v); } },
  max_health: { put: (b) => (inRow("max_health", b.max_health) ? Math.round(b.max_health) : undefined), get: (b, v) => { b.max_health = int(v); } },
};

/** Whether a snapshot of a match of `tier` holds its heroes' health: the replay tier's alone
 * (the metadata tier's is the path's, too coarse for Player to hold: mapstate/state.ts). Save
 * and Retake capture by it, and a scene reads by it (`scene.ts`, `CAPTURED.health`), each asking
 * the scene's own `source.tier`. */
export const holdsHealth = (tier: string | null | undefined): boolean => tier === "replay";

/** The build at second `t` of the match, as Player's column shows it. `tier`: the tier of the
 * snapshot it is captured for (the scene's `source.tier`, null for a scene with none; by default
 * the timeline's own). */
export function heroBuildAt(tl: Pick<Timeline, "events" | "players" | "format" | "tier">, player: TimelinePlayer, t: number, tier: string | null = tl.tier ?? "metadata"): HeroBuild {
  const at: BuildAt = buildAt(player, t);
  const sec = Math.max(0, Math.floor(t));
  let pickups: Pickups | null = (tl.format ?? 0) >= PICKUPS_FORMAT ? [0, 0, 0, 0, 0] : null;
  if (pickups) for (const [s, v] of player.pickups ?? []) { if (s > t) break; pickups = v; }
  return {
    hero: player.hero_id,
    items: at.items,
    abilities: at.abilities,
    order: player.items == null ? null : [...player.items].filter(([ds]) => ds <= t * 10).sort((a, b) => a[0] - b[0]),
    level: scoreboardValueAt(player.level, t),
    // Only for a snapshot that holds it, and only from the replay's own samples.
    health: holdsHealth(tier) && tl.tier === "replay" && player.x[sec] != null ? player.health[sec] ?? null : null,
    pickups,
    kills: player.kills != null ? scoreboardValueAt(player.kills, t) : killsAt(tl, t, player.team, player.slot),
    deaths: player.deaths.filter((d) => d <= t).length,
    assists: scoreboardValueAt(player.assists, t),
    max_health: scoreboardValueAt(player.max_health, t),
  };
}

const jsonLen = (more: More) => new TextEncoder().encode(JSON.stringify(more)).length;
/** A `more`'s size as the server counts it against `max_more_bytes`: its JSON, in bytes. */
export const moreBytes = jsonLen;

/** A build as the hero record's `more`: the rows this build writes, within `budget` bytes of
 * JSON (at most one record's cap, `max_more_bytes`; less when a save's twelve must share one
 * transaction). Over it, the build order loses its oldest rows first; what is left may still be
 * over a small budget, which the caller checks (`moreBytes`). */
export function captureBuild(build: HeroBuild, budget: number = LIMITS.max_more_bytes): More {
  const more: More = {};
  for (const key of Object.keys(HERO) as HeroKey[]) {
    if (ROWS[key].index >= WRITTEN) continue;
    const v = HERO[key].put(build);
    if (v !== undefined) more[key] = v;
  }
  while (jsonLen(more) > Math.min(budget, LIMITS.max_more_bytes)) {
    const order = more.build_order as number[] | undefined;
    if (!order?.length) { delete more.build_order; break; }
    more.build_order = order.slice(Math.ceil(order.length / ORDER / 2) * ORDER);
  }
  return more;
}

/** Which of a hero's rows are its build: what a pick of another hero in a scene that holds its
 * heroes drops with the old hero (edit.ts), and what such a record must still hold to have a
 * build (buildView.ts `holdsBuild`). Every hero row says which it is. */
const IS_BUILD: { [K in HeroKey]-?: boolean } = {
  hero: false, name: false,
  items: true, abilities: true, build_order: true, level: true, health: true, pickups: true, kills: true, deaths: true, assists: true, max_health: true,
};
export const BUILD_KEYS = (Object.keys(IS_BUILD) as HeroKey[]).filter((k) => IS_BUILD[k]);

/** What a snapshot's state says of the scene, by what the save stored. */
export interface SceneCapture {
  /** The heroes' builds are stored (default true). */
  builds?: boolean;
  /** The scene holds its own heroes (spec D2; default true). Retake never says so: it adds to
   * a scene saved before, whose heroes are the board roster's. */
  heroes?: boolean;
  /** The rows this build writes (default `WRITTEN`; tests pass a later build's). */
  written?: number;
}

/** The scene's own rows for a snapshot: the watermark, what it holds, the patch. A row this
 * build doesn't write yet is left out, so `has_heroes` is stored only once it is `live`. */
export function captureScene(tl: Pick<Timeline, "build">, opts: SceneCapture = {}): More {
  const patch = tl.build;
  const written = opts.written ?? WRITTEN;
  const builds = opts.builds !== false;
  const scene: { [K in SceneKey]-?: MoreValue | undefined } = {
    rows: written,
    has_builds: builds ? true : undefined,
    build: builds && patch != null && inRow("build", patch) ? patch : undefined,
    has_heroes: opts.heroes !== false ? true : undefined,
  };
  return Object.fromEntries(Object.entries(scene).filter(([k, v]) => v !== undefined && ROWS[k as SceneKey].index < written)) as More;
}

/** Whether a save that writes `written` rows gives a scene its own heroes (spec D2): once
 * `has_heroes` is a row it writes. */
export const writesHeroes = (written: number = WRITTEN): boolean => ROWS.has_heroes.index < written;

/** How many rows Retake can give a scene: every written row but `has_heroes`, which only a
 * save sets. A scene whose watermark is below this has something to retake. */
export function retakeRows(written: number = WRITTEN): number {
  const mine = (Object.values(ROWS) as Row[]).filter((r) => r.index < written && r.index !== ROWS.has_heroes.index).map((r) => r.index);
  return mine.length ? Math.max(...mine) + 1 : 0;
}

/** What a scene's state says it holds (spec §4.5). No state, or an empty one: nothing.
 * `heroes`: the scene's own heroes win over the board roster's (D2). */
export function captured(scene: More | undefined): { builds: boolean; heroes: boolean; rows: number; patch: number | undefined } {
  const rows = int(scene?.rows) ?? 0;
  return { builds: scene?.has_builds === true && rows > 0, heroes: scene?.has_heroes === true && ROWS.has_heroes.index < rows, rows, patch: int(scene?.build) ?? undefined };
}

/** The hero a slot holds in a scene (spec D2): the scene's own (`hero` on the hero's record)
 * when the snapshot holds its heroes, else the board roster's. In a scene saved before
 * `has_heroes`, a `hero` that differs from the roster's is a build whose slot was given
 * another hero since: the roster's is drawn, and the build is not (`holdsBuild`). */
export function sceneHero(own: boolean, more: More | undefined, roster: number | null | undefined): number | null {
  const mine = more?.hero;
  return own && typeof mine === "number" ? mine : (roster ?? null);
}

/** The build a hero's record holds, read by a snapshot whose watermark is `rows`. A row at or
 * above the watermark, or absent, reads as not captured (null). */
export function readBuild(more: More | undefined, rows: number, hero: number): HeroBuild {
  const b: HeroBuild = { hero, items: null, abilities: null, order: null, level: null, health: null, pickups: null, kills: null, deaths: null, assists: null, max_health: null };
  for (const key of Object.keys(HERO) as HeroKey[]) if (ROWS[key].index < rows) HERO[key].get(b, more?.[key]);
  return b;
}

/** The calculator's input from a build (match/stats.ts `statBuild`, which Player uses): null
 * without the level, the items or the pickups. A dead hero counts as full health, and so does
 * one alive in the scene whose health the frame doesn't hold (it was dead there, and revived
 * since: spec §5). */
export function statOf(b: HeroBuild, alive: boolean): StatBuild | null {
  if (b.level == null || b.items == null || b.pickups == null) return null;
  const [max_health, spirit_power, weapon_damage, bullet_resist, spirit_resist] = b.pickups;
  return {
    hero_id: b.hero,
    level: b.level,
    items: b.items.map((i) => i.id),
    ability_tiers: (b.abilities ?? []).filter((a) => a.level >= 2).map((a) => [a.id, a.level - 1]),
    pickups: { max_health, spirit_power, weapon_damage, bullet_resist, spirit_resist },
    health_pct: alive ? (b.health ?? 100) : 100,
  };
}
