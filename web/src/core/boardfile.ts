// A board as a file, `<title>.mapcro.json` (spec §6; crates/server/src/boardfile.rs): Download
// saves the board the server exports, Import board sends a file's bytes as they are and gets
// a new board back. The server checks everything; the client only names the file and says
// why one was refused, in a tag (§4b). In the app's window the browser's blob link does nothing,
// so Download goes through the app's Save as dialog (`board_file_save`) instead.

import { authHeader } from "./cred";
import type { Via } from "../gen/Via";
import { bridge, type Invoke } from "../player/desktop";

/** The server's cap on a board file (`boardfile::MAX_BYTES`). */
export const MAX_FILE_BYTES = 8 * 1024 * 1024;

/** A JSON file: what the landing's drop takes as a board file rather than a replay. */
export const isJsonFile = (name: string) => /\.json$/i.test(name);

/** A board's download, by its name: `<title>.mapcro.json`, or as a browser renames a second
 * copy (`<title>.mapcro (1).json`). Only these are sent when dropped; another JSON file isn't
 * a board, and sending it would spend a creation attempt to be told so. */
export const isBoardFile = (name: string) => /\.mapcro(?: ?\(\d+\))?\.json$/i.test(name);

/** Names Windows keeps for devices, alone or before any extension (`CON.mapcro.json`). */
const RESERVED = /^(?:con|prn|aux|nul|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3])$/i;

/** `<title>.mapcro.json`, with what a file system refuses replaced, and the marks that would
 * make the name read other than it is (bidi overrides) taken out. At most 80 characters. */
export function fileName(title: string): string {
  const cleaned = title
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029<>:"/\\|?*]/g, "_")
    .replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "");
  let base = Array.from(cleaned.replace(/^[\s.]+/, "")).slice(0, 80).join("").replace(/[\s.]+$/, "");
  if (RESERVED.test(base.split(".")[0]!.trim())) base = `_${base}`;
  return `${base || "board"}.mapcro.json`;
}

/** The tag for a refused import or download: the server's code, else its status. */
export function refusalTag(status: number, code?: string): string {
  if (code === "newer") return "Newer file";
  if (code === "too_large" || status === 413) return "Too large";
  if (code === "not_a_board") return "Not a board";
  if (code === "invalid" || code === "too_deep") return "Bad file";
  if (status === 429 || status === 503 || status === 408 || code === "busy" || code === "timeout") return "Try later";
  if (status === 507) return "Server full";
  return "Failed";
}

async function codeOf(r: Response): Promise<string | undefined> {
  const body = (await r.json().catch(() => undefined)) as { error?: unknown } | undefined;
  return typeof body?.error === "string" ? body.error : undefined;
}

/** Save the board as a file. Resolves to a refusal tag, or nothing once it's saved (or the
 * user cancelled the app's Save as dialog). */
export async function downloadBoard(board: string, token: string, title: string, via?: Via, invoke: Invoke | undefined = bridge()): Promise<string | undefined> {
  const r = await fetch(`/api/boards/${board}/export`, { headers: { authorization: authHeader(token, via) } }).catch(() => undefined);
  if (!r) return "Offline";
  if (!r.ok) return refusalTag(r.status, await codeOf(r));
  const blob = await r.blob();
  // In the app: the system's Save as dialog, named here, written where the user chose. A blob
  // URL and `<a download>` are ignored by both WebView2 and WebKitGTK, so nothing happened.
  if (invoke) {
    try {
      const answer = await invoke("board_file_save", { name: fileName(title), contents: await blob.text() });
      return answer === "saved" || answer === "cancelled" ? undefined : "Failed";
    } catch (e) {
      return e === "too_large" ? "Too large" : "Failed";
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName(title);
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return undefined;
}

export interface Imported {
  board: string;
  owner_token: string;
  title: string;
  /** The board's matches, newest first. */
  matches: number[];
}

/** Make a new board from a file. */
export async function importBoard(file: Blob): Promise<Imported | { error: string }> {
  if (file.size > MAX_FILE_BYTES) return { error: "Too large" };
  const r = await fetch("/api/boards/import", { method: "POST", headers: { "content-type": "application/json" }, body: file }).catch(() => undefined);
  if (!r) return { error: "Offline" };
  if (!r.ok) return { error: refusalTag(r.status, await codeOf(r)) };
  return (await r.json()) as Imported;
}
