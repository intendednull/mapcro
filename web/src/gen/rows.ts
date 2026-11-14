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
  kills: { index: 11, entity: "hero", kind: "int", min: 0, max: 100000, status: "ahead" as RowStatus },
  deaths: { index: 12, entity: "hero", kind: "int", min: 0, max: 100000, status: "ahead" as RowStatus },
  assists: { index: 13, entity: "hero", kind: "int", min: 0, max: 100000, status: "ahead" as RowStatus },
  max_health: { index: 14, entity: "hero", kind: "int", min: 0, max: 10000000, status: "ahead" as RowStatus },
} as const;

export type RowKey = keyof typeof ROWS;

/** Whether a scene's state (`SceneState`) may be created yet. */
export const SCENE_STATE: RowStatus = "live";
