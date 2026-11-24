// Generated from crates/schema/src/map_state.rs `ROWS` by `just ts`. Do not edit.

/** A row is read by every build that knows it; `ahead`: nothing writes it yet. */
export type RowStatus = "ahead" | "live" | "retired";

/** Every map-state row, in registry order (`index`): what it belongs to, its kind and bounds. */
export const ROWS = {
  hero: { index: 0, entity: "hero", kind: "int", min: 0, max: 4294967295, status: "live" as RowStatus },
  name: { index: 1, entity: "hero", kind: "text", max: 24, status: "live" as RowStatus },
  rows: { index: 2, entity: "scene", kind: "int", min: 0, max: 65535, status: "live" as RowStatus },
  has_builds: { index: 3, entity: "scene", kind: "bool", status: "live" as RowStatus },
  build: { index: 4, entity: "scene", kind: "int", min: 0, max: 4294967295, status: "live" as RowStatus },
  items: { index: 5, entity: "hero", kind: "ints", len: 128, min: -1, max: 4294967295, status: "live" as RowStatus },
  abilities: { index: 6, entity: "hero", kind: "ints", len: 48, min: -1, max: 4294967295, status: "live" as RowStatus },
  build_order: { index: 7, entity: "hero", kind: "ints", len: 600, min: -1, max: 4294967295, status: "live" as RowStatus },
  level: { index: 8, entity: "hero", kind: "int", min: 0, max: 1000, status: "live" as RowStatus },
  health: { index: 9, entity: "hero", kind: "int", min: 0, max: 100, status: "live" as RowStatus },
  pickups: { index: 10, entity: "hero", kind: "ints", len: 16, min: -1000000000, max: 1000000000, status: "live" as RowStatus },
  kills: { index: 11, entity: "hero", kind: "int", min: 0, max: 100000, status: "live" as RowStatus },
  deaths: { index: 12, entity: "hero", kind: "int", min: 0, max: 100000, status: "live" as RowStatus },
  assists: { index: 13, entity: "hero", kind: "int", min: 0, max: 100000, status: "live" as RowStatus },
  max_health: { index: 14, entity: "hero", kind: "int", min: 0, max: 10000000, status: "live" as RowStatus },
  has_heroes: { index: 15, entity: "scene", kind: "bool", status: "live" as RowStatus },
  has_sight: { index: 16, entity: "scene", kind: "bool", status: "live" as RowStatus },
  unseen: { index: 17, entity: "hero", kind: "bool", status: "live" as RowStatus },
  has_cc: { index: 18, entity: "scene", kind: "bool", status: "live" as RowStatus },
  cc: { index: 19, entity: "hero", kind: "int", min: 0, max: 15, status: "live" as RowStatus },
  has_movement: { index: 20, entity: "scene", kind: "bool", status: "live" as RowStatus },
  height: { index: 21, entity: "hero", kind: "int", min: 0, max: 15, status: "live" as RowStatus },
  zipline: { index: 22, entity: "hero", kind: "bool", status: "live" as RowStatus },
  has_lanes: { index: 23, entity: "scene", kind: "bool", status: "live" as RowStatus },
  edges: { index: 24, entity: "lane", kind: "ints", len: 2, min: 0, max: 1000, status: "live" as RowStatus },
  has_skulls: { index: 25, entity: "scene", kind: "bool", status: "live" as RowStatus },
  skulls: { index: 26, entity: "scene", kind: "ints", len: 36, min: 0, max: 255, status: "live" as RowStatus },
  has_camps: { index: 27, entity: "scene", kind: "bool", status: "live" as RowStatus },
  camps: { index: 28, entity: "scene", kind: "ints", len: 600, min: -1, max: 4294967295, status: "live" as RowStatus },
  has_powerups: { index: 29, entity: "scene", kind: "bool", status: "live" as RowStatus },
  powerups: { index: 30, entity: "scene", kind: "ints", len: 20, min: -1, max: 4294967295, status: "live" as RowStatus },
  has_obj_health: { index: 31, entity: "scene", kind: "bool", status: "live" as RowStatus },
  obj_health: { index: 32, entity: "scene", kind: "ints", len: 120, min: -1, max: 4294967295, status: "live" as RowStatus },
  has_rifts: { index: 33, entity: "scene", kind: "bool", status: "live" as RowStatus },
  rift: { index: 34, entity: "scene", kind: "ints", len: 8, min: -1, max: 4294967295, status: "live" as RowStatus },
  has_urn: { index: 35, entity: "scene", kind: "bool", status: "live" as RowStatus },
  urn: { index: 36, entity: "scene", kind: "ints", len: 8, min: -1, max: 4294967295, status: "live" as RowStatus },
  urn_at: { index: 37, entity: "scene", kind: "pos", status: "live" as RowStatus },
  has_rejuv: { index: 38, entity: "scene", kind: "bool", status: "live" as RowStatus },
  rejuv: { index: 39, entity: "scene", kind: "ints", len: 8, min: -1, max: 4294967295, status: "live" as RowStatus },
  has_doors: { index: 40, entity: "scene", kind: "bool", status: "live" as RowStatus },
  doors: { index: 41, entity: "scene", kind: "ints", len: 24, min: -16384, max: 16384, status: "live" as RowStatus },
} as const;

export type RowKey = keyof typeof ROWS;

/** Whether a scene's state (`SceneState`) may be created yet. */
export const SCENE_STATE: RowStatus = "live";
