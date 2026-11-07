// What the save indicator says (design/v1-board/states.html): never "Saved" while a change is
// waiting, and a refusal is named. Labels only. Pure, so the wording is tested without a server.

import type { Connection } from "../core/session";
import type { SaveStatus } from "../core/update";
import type { Reject } from "../gen/Reject";

export type StatusKind = "saved" | "syncing" | "offline" | "rejected" | "closed" | "connecting";

export interface StatusView {
  kind: StatusKind;
  text: string;
}

/** Short labels for refusals (operator: labels, not explanations). */
const REASONS: Record<Reject, string> = {
  EmptyTx: "Empty change",
  TooManyOps: "Change too big",
  TooManyRecords: "Board full",
  TooManyScenes: "Scene limit",
  IdTaken: "Conflict",
  NoSuchRecord: "Already gone",
  Immutable: "Read-only",
  WrongField: "Invalid change",
  MismatchedSetIf: "Invalid undo",
  TextTooLong: "Text too long",
  BadText: "Invalid text",
  OutOfBounds: "Out of range",
  BadObjectiveKey: "Unknown objective",
  BadOrderKey: "Invalid order",
  NoSuchScene: "Scene gone",
  NoSuchSlot: "Unknown slot",
  Duplicate: "Duplicate",
  IncompleteScene: "Incomplete scene",
  LastScene: "Last scene",
  Forbidden: "View only",
  BadStroke: "Invalid ink",
  TxTooLarge: "Change too big",
  BoardFull: "Board full",
  ServerFull: "Server full",
};

/** The reason in a session problem string (`rejected: "TextTooLong"`), if it is a rejection. */
export function rejection(problem: string): Reject | undefined {
  const m = /^rejected: "(\w+)"$/.exec(problem);
  return m && m[1]! in REASONS ? (m[1] as Reject) : undefined;
}

export function explain(r: Reject): string {
  return REASONS[r];
}

/**
 * @param syncingShown whether a pending change has waited long enough (400 ms) to say so
 * @param rejected the newest rejection the user hasn't dismissed
 */
export function statusView(s: SaveStatus, c: Connection, syncingShown: boolean, rejected: Reject | undefined): StatusView {
  if (c.kind === "closed") return { kind: "closed", text: c.reason === "revoked" ? "Link revoked" : "Invalid link" };
  if (rejected) return { kind: "rejected", text: REASONS[rejected] };
  if (s.kind === "offline" || c.kind === "waiting") {
    const n = s.kind === "saved" ? 0 : s.pending;
    return { kind: "offline", text: n ? `Offline: ${n} kept` : "Offline" };
  }
  if (s.kind === "syncing" && syncingShown) return { kind: "syncing", text: `Syncing ${s.pending}` };
  if (c.kind === "connecting" && s.kind === "saved") return { kind: "connecting", text: "Connecting" };
  // Pending but not yet 400 ms old: still not "Saved".
  if (s.kind === "syncing") return { kind: "syncing", text: "" };
  return { kind: "saved", text: "Saved" };
}
