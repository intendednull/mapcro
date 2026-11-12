// Generated from crates/schema/src/validate.rs `LIMITS` by `just ts`. Do not edit.

/** The schema's limits, in characters (Unicode scalar values) where they're text. */
export const LIMITS = {
  max_ops_per_tx: 256,
  max_records: 5000,
  max_scenes: 64,
  max_name: 24,
  max_title: 80,
  max_callout: 80,
  max_note: 4000,
  max_label: 40,
  max_stroke_points: 512,
  max_tx_bytes: 65536,
  max_tabs: 2000,
  max_coord: 16384,
} as const;
