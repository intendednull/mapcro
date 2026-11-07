// What the save indicator says (design/v1-board/states.html): never "Saved" while a change is
// waiting, and a refusal says why. Pure, so the wording is tested without a server.

import type { Connection } from "../core/session";
import type { SaveStatus } from "../core/update";
import type { Reject } from "../gen/Reject";

export type StatusKind = "saved" | "syncing" | "offline" | "rejected" | "closed" | "connecting";

export interface StatusView {
  kind: StatusKind;
  text: string;
  why?: string;
}

const REASONS: Record<Reject, string> = {
  EmptyTx: "the change was empty",
  TooManyOps: "the change was too big",
  TooManyRecords: "the board is full",
  TooManyScenes: "the board has the most scenes it can hold (64)",
  IdTaken: "it clashed with something that already exists",
  NoSuchRecord: "what it changed no longer exists",
  Immutable: "that part of the board can't be changed",
  WrongField: "it changed a field that doesn't exist",
  MismatchedSetIf: "an undo was malformed",
  TextTooLong: "the text is too long",
  BadText: "the text has characters a board can't hold",
  OutOfBounds: "a value was out of range",
  BadObjectiveKey: "it named an objective the map doesn't have",
  BadOrderKey: "the scene order was malformed",
  NoSuchScene: "its scene no longer exists",
  NoSuchSlot: "its roster slot doesn't exist",
  Duplicate: "the scene already has one of those",
  IncompleteScene: "a scene needs every player",
  LastScene: "a board keeps at least one scene",
  Forbidden: "this link can only view",
  BadStroke: "the ink stroke was malformed",
  TxTooLarge: "the change was too big",
  BoardFull: "the board is full",
  ServerFull: "the server is out of space",
};

const WHY_REJECTED = "The server refused this change, so it isn't on the board. Everything else you did is saved.";
/** Refusals that will repeat for every change, so the explanation says what to do instead. */
const WHY: Partial<Record<Reject, string>> = {
  BoardFull:
    "This board holds as much history as the server keeps for now, so it takes no more changes. Everything on it is saved and still opens. Clone it to keep working on a fresh copy.",
  ServerFull: "The server is out of space for changes right now. Everything already on the board is saved.",
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
  if (c.kind === "closed") return { kind: "closed", text: "This link doesn't open a board" };
  if (rejected) return { kind: "rejected", text: `Rejected: ${REASONS[rejected]}`, why: WHY[rejected] ?? WHY_REJECTED };
  if (s.kind === "offline" || c.kind === "waiting") {
    const n = s.kind === "saved" ? 0 : s.pending;
    return { kind: "offline", text: n ? `Offline: ${n} change${n === 1 ? "" : "s"} kept on this device` : "Offline: reconnecting" };
  }
  if (s.kind === "syncing" && syncingShown) return { kind: "syncing", text: `Syncing (${s.pending})` };
  if (c.kind === "connecting" && s.kind === "saved") return { kind: "connecting", text: "Connecting…" };
  // Pending but not yet 400 ms old: still not "Saved".
  if (s.kind === "syncing") return { kind: "syncing", text: "" };
  return { kind: "saved", text: "Saved" };
}
