// The shape `BoardReplica` returns from every call (crates/wasm/src/lib.rs, `Update`).
import type { Entry } from "../gen/Entry";
import type { RecordId } from "../gen/RecordId";
import type { WireIn } from "../gen/WireIn";

export type SaveStatus =
  | { kind: "saved" }
  | { kind: "syncing"; pending: number }
  | { kind: "offline"; pending: number };

export interface Update {
  frames: WireIn[];
  changed: Array<[RecordId, Entry | null]>;
  status: SaveStatus;
  canUndo: boolean;
  canRedo: boolean;
  refused: string | null;
}
