// A board as a file, `<title>.mapcro.json` (spec §6; crates/server/src/boardfile.rs): Download
// saves the board the server exports, Import board sends a file's bytes as they are and gets
// a new board back. The server checks everything; the client only names the file and says
// why one was refused, in a tag (§4b).

/** The server's cap on a board file (`boardfile::MAX_BYTES`). */
export const MAX_FILE_BYTES = 8 * 1024 * 1024;

export const isBoardFile = (name: string) => /\.json$/i.test(name);

/** `<title>.mapcro.json`, with what a file system refuses replaced. */
export function fileName(title: string): string {
  // eslint-disable-next-line no-control-regex
  const base = title.replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, "_").replace(/^[\s.]+|[\s.]+$/g, "").slice(0, 80);
  return `${base || "board"}.mapcro.json`;
}

/** The tag for a refused import or download: the server's code, else its status. */
export function refusalTag(status: number, code?: string): string {
  if (code === "newer") return "Newer file";
  if (code === "too_large" || status === 413) return "Too large";
  if (code === "not_a_board") return "Not a board";
  if (code === "invalid" || code === "too_deep") return "Bad file";
  if (status === 429) return "Try later";
  if (status === 507) return "Server full";
  return "Failed";
}

async function codeOf(r: Response): Promise<string | undefined> {
  const body = (await r.json().catch(() => undefined)) as { error?: unknown } | undefined;
  return typeof body?.error === "string" ? body.error : undefined;
}

/** Save the board as a file. Resolves to a refusal tag, or nothing once it's saved. */
export async function downloadBoard(board: string, token: string, title: string): Promise<string | undefined> {
  const r = await fetch(`/api/boards/${board}/export`, { headers: { authorization: `Bearer ${token}` } }).catch(() => undefined);
  if (!r) return "Offline";
  if (!r.ok) return refusalTag(r.status, await codeOf(r));
  const url = URL.createObjectURL(await r.blob());
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
