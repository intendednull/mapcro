// Leaf definitions for map-state keys, watermark, byte sizing, and captured snapshot flags
// (TD-159). Imports only generated schema types/rows so `mapstate/undo.ts` and `core/session.ts`
// never cycle through `mapstate/build.ts`, `match/*`, or `board/*`.

import type { More } from "../gen/More";
import { ROWS, type RowKey } from "../gen/rows";

type Row = (typeof ROWS)[RowKey];
export type HeroKey = { [K in RowKey]: (typeof ROWS)[K]["entity"] extends "hero" ? K : never }[RowKey];
export type SceneKey = { [K in RowKey]: (typeof ROWS)[K]["entity"] extends "scene" ? K : never }[RowKey];

/** The registry's length as far as this build writes it: the rows before the first one still
 * `ahead` (rows go live in order). A snapshot stores it as its watermark (`rows`, spec §4.5):
 * a row at or above it was not captured, whatever a later build knows. */
export const WRITTEN: number = (() => {
  const rows = Object.values(ROWS) as Row[];
  const ahead = rows.filter((r) => r.status === "ahead").map((r) => r.index);
  return ahead.length ? Math.min(...ahead) : rows.length;
})();

/** Which of a hero's rows are its build: what a pick of another hero in a scene that holds its
 * heroes drops with the old hero (edit.ts), and what such a record must still hold to have a
 * build (buildView.ts `holdsBuild`). Every hero row says which it is. */
export const IS_BUILD: { [K in HeroKey]-?: boolean } = {
  hero: false,
  name: false,
  items: true,
  abilities: true,
  build_order: true,
  level: true,
  health: true,
  pickups: true,
  kills: true,
  deaths: true,
  assists: true,
  max_health: true,
  // Phase 5 Group A: slot-at-the-frame facts, kept on hero pick (plan §6).
  unseen: false,
  cc: false,
  height: false,
  zipline: false,
};

export const BUILD_KEYS = (Object.keys(IS_BUILD) as HeroKey[]).filter((k) => IS_BUILD[k]);

/** A `more`'s size as the server counts it against `max_more_bytes`: its JSON, in bytes. */
export const moreBytes = (more: More) => new TextEncoder().encode(JSON.stringify(more)).length;

export interface CapturedSnapshot {
  builds: boolean;
  heroes: boolean;
  sight: boolean;
  cc: boolean;
  movement: boolean;
  lanes: boolean;
  skulls: boolean;
  camps: boolean;
  powerups: boolean;
  obj_health: boolean;
  rifts: boolean;
  urn: boolean;
  rejuv: boolean;
  doors: boolean;
  rows: number;
  patch: number | undefined;
}

const int = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) ? v : null);

/** What a scene's state says it holds (spec §4.5). No state, or an empty one: nothing.
 * `heroes`: the scene's own heroes win over the board roster's (D2). */
export function captured(scene: More | undefined): CapturedSnapshot {
  const rows = int(scene?.rows) ?? 0;
  const flag = (k: SceneKey, last: RowKey) => scene?.[k] === true && ROWS[last].index < rows;
  return {
    builds: scene?.has_builds === true && rows > 0,
    heroes: flag("has_heroes", "has_heroes"),
    sight: flag("has_sight", "unseen"),
    cc: flag("has_cc", "cc"),
    movement: flag("has_movement", "zipline"),
    lanes: flag("has_lanes", "edges"),
    skulls: flag("has_skulls", "skulls"),
    camps: flag("has_camps", "camps"),
    powerups: flag("has_powerups", "powerups"),
    obj_health: flag("has_obj_health", "obj_health"),
    rifts: flag("has_rifts", "rift"),
    urn: flag("has_urn", "urn_at"),
    rejuv: flag("has_rejuv", "rejuv"),
    doors: flag("has_doors", "doors"),
    rows,
    patch: int(scene?.build) ?? undefined,
  };
}
