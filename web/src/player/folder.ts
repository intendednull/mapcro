// The linked replays folder (spec §6b, Getting a replay in): on a browser with the File System
// Access API (Chromium), an editor links the game's replays folder once, and Player finds the
// open match's `<match id>.dem` in it. Elsewhere nothing changes: the picker and the drop stay.
// The pure parts and the browser calls, with no Solid, so `folder.test.ts` drives them with a
// stub handle.
//
// Privacy: only `<digits>.dem` entries are opened (for their size and time, and the one that's
// uploaded); nothing else in the folder is read, and nothing about it is sent or logged. A name
// leaves this module only as its match id.

/** The game's replays folder inside a Steam library, written without OS separators (operator, 2026-11-10; journal 2026-11-08-player-handoff). */
export const REPLAYS_PATH = "Steam library › steamapps › common › Deadlock › game › citadel › replays";

/** How often Player looks again while it's open and the tab is shown (also on focus). */
export const POLL_MS = 15_000;

/** A file this new may still be downloading: it's offered once it has sat this long. */
export const SETTLE_MS = 5_000;

export type Access = "granted" | "prompt" | "denied";

/** The parts of a `FileSystemFileHandle` used here. */
export interface FileHandleLike {
  kind: "file";
  name: string;
  getFile(): Promise<File>;
}
/** The parts of a `FileSystemDirectoryHandle` used here (`queryPermission` and
 * `requestPermission` aren't in TypeScript's DOM types yet). */
export interface DirHandleLike {
  kind: "directory";
  name: string;
  values(): AsyncIterable<FileHandleLike | { kind: "directory"; name: string }>;
  getFileHandle(name: string): Promise<FileHandleLike>;
  queryPermission?(d: { mode: "read" }): Promise<PermissionState>;
  requestPermission?(d: { mode: "read" }): Promise<PermissionState>;
}

/** A replay a source has: its match id, when it was written, its size. */
export interface Replay {
  id: string;
  lastModified: number;
  size: number;
}

/**
 * Where Player finds replays without a file dialog (lead, 2026-11-10): the linked folder today;
 * a desktop bridge could be another. The UI reads only through this.
 */
export interface ReplaySource {
  /** Its replays, newest first. Throws when it can't be read (see `lookFailed`). */
  list(): Promise<Replay[]>;
  /** One replay's file, by match id. */
  read(id: string): Promise<File>;
}

/** The linked folder as a source: only `<match id>.dem` files are opened, by name. */
export function folderSource(dir: DirHandleLike): ReplaySource {
  return {
    list: () => listReplays(dir),
    read: async (id) => (await dir.getFileHandle(`${id}.dem`)).getFile(),
  };
}

/** The match id a replay file's name is (the game names it `<match id>.dem`); nothing for any
 * other name. Stricter than `idFromName`: a renamed copy (`123 (1).dem`) isn't the game's. */
export function replayId(name: string): string | undefined {
  const m = /^0*([1-9]\d*)\.dem$/i.exec(name);
  return m?.[1];
}

/** Newest first, by when the file was written; the larger match id first on a tie. */
export function newestFirst<T extends { id: string; lastModified: number }>(list: readonly T[]): T[] {
  return [...list].sort((a, b) => b.lastModified - a.lastModified || cmpId(b.id, a.id));
}
const cmpId = (a: string, b: string) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);

/** Has the file sat long enough to be a finished download? */
export const settled = (r: { lastModified: number }, now: number) => now - r.lastModified >= SETTLE_MS;

/** The open match's replay in the folder, once it has settled. */
export function found(list: readonly Replay[], id: string | undefined, now: number): Replay | undefined {
  return id ? list.find((r) => r.id === id && settled(r, now)) : undefined;
}

/** Other recent replays to offer, newest first (the open match's excluded). */
export function recent(list: readonly Replay[], except: string | undefined, now: number, n = 3): Replay[] {
  return list.filter((r) => r.id !== except && settled(r, now)).slice(0, n);
}

/** When to look again for a file still settling, if any is (ms from `now`). */
export function settleIn(list: readonly Replay[], now: number): number | undefined {
  const waits = list.filter((r) => !settled(r, now)).map((r) => SETTLE_MS - (now - r.lastModified));
  return waits.length ? Math.max(250, Math.min(...waits) + 50) : undefined;
}

/**
 * Read access to the folder. `ask` only from a click: the browser asks the user then, and
 * refuses to without a user gesture. A handle without the calls (an older browser) is taken as
 * granted; a call that throws is taken as needing the user's click.
 */
export async function access(dir: DirHandleLike, ask: boolean): Promise<Access> {
  try {
    const now = dir.queryPermission ? await dir.queryPermission({ mode: "read" }) : "granted";
    if (now !== "prompt" || !ask || !dir.requestPermission) return now;
    return await dir.requestPermission({ mode: "read" });
  } catch {
    return "prompt";
  }
}

/** The folder's replays, newest first: only `<match id>.dem` files are opened. */
export async function listReplays(dir: DirHandleLike): Promise<Replay[]> {
  const out: Replay[] = [];
  for await (const e of dir.values()) {
    if (e.kind !== "file") continue;
    const id = replayId(e.name);
    if (!id) continue;
    const f = await e.getFile();
    out.push({ id, lastModified: f.lastModified, size: f.size });
  }
  return newestFirst(out);
}

/** The line after the picker gave no folder: cancelled, or refused (Chrome won't open a folder
 * under Program Files or ~/.local/share, where Steam installs by default). */
export const NOT_LINKED = "Browsers can't link Steam's default folder. Upload the file instead.";

/** What a failed look at the folder means: access lost (ask again on a click), or the folder's
 * gone (link it again). */
export function lookFailed(e: unknown): "prompt" | "gone" {
  const name = (e as { name?: string } | null)?.name;
  return name === "NotAllowedError" || name === "SecurityError" ? "prompt" : "gone";
}

/** Can this browser link a folder? Chromium's `showDirectoryPicker`, in a secure context. */
export function supported(w: { showDirectoryPicker?: unknown; isSecureContext?: boolean } = globalThis as never): boolean {
  return typeof w.showDirectoryPicker === "function" && w.isSecureContext !== false;
}

// ---- the handle, kept in IndexedDB so a later visit reuses it ----

const DB = "mapcro-replays-folder";
const STORE = "handles";
const KEY = "replays";

function open(idb: IDBFactory): Promise<IDBDatabase> {
  return new Promise((ok, fail) => {
    const req = idb.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => ok(req.result);
    req.onerror = () => fail(req.error);
  });
}
async function run<T>(idb: IDBFactory, mode: IDBTransactionMode, f: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open(idb);
  try {
    return await new Promise<T>((ok, fail) => {
      const req = f(db.transaction(STORE, mode).objectStore(STORE));
      req.onsuccess = () => ok(req.result);
      req.onerror = () => fail(req.error);
    });
  } finally {
    db.close();
  }
}

/** Keep the linked folder for later visits. A handle that can't be stored (a private window)
 * still works for this visit. */
export async function saveFolder(dir: DirHandleLike, idb: IDBFactory = indexedDB): Promise<boolean> {
  try {
    await run(idb, "readwrite", (s) => s.put(dir, KEY));
    return true;
  } catch {
    return false;
  }
}

/** The folder linked on an earlier visit, if any. */
export async function loadFolder(idb: IDBFactory = indexedDB): Promise<DirHandleLike | undefined> {
  try {
    const v = await run<unknown>(idb, "readonly", (s) => s.get(KEY));
    return v && typeof v === "object" && (v as DirHandleLike).kind === "directory" ? (v as DirHandleLike) : undefined;
  } catch {
    return undefined;
  }
}

/** Forget the linked folder (it's gone). */
export async function forgetFolder(idb: IDBFactory = indexedDB): Promise<void> {
  try {
    await run(idb, "readwrite", (s) => s.delete(KEY));
  } catch {
    // Nothing kept, nothing to forget.
  }
}
