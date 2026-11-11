// The Windows app's bridge (desktop/README.md): the same site, in the app's window, with five
// commands to the native side: list the replays folder, read one replay, preview one (read from
// its demo here), parse one here, and change the folder (the system's folder chooser). The page passes only match ids, never paths,
// and the app grants the commands to this site's origin only. Feature-detected: in a browser none of this exists, and nothing changes.
//
// Also the download links for the app (`windowsAppLink`, `windowsPortableLink`), shown on
// Windows browsers only, and the portable app's update notice (`appUpdate`).

import { type Replay, type ReplaySource, newestFirst } from "./folder";

/** Tauri's IPC call, as its injected script defines it on every page in the app's window. */
export type Invoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

type TauriWindow = { __TAURI_INTERNALS__?: { invoke?: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> } };

/** The app's IPC, when this page is in the app's window. */
export function bridge(w: unknown = globalThis): Invoke | undefined {
  const t = (w as TauriWindow | undefined)?.__TAURI_INTERNALS__;
  const invoke = t?.invoke;
  return typeof invoke === "function" ? (cmd, args) => invoke.call(t, cmd, args) : undefined;
}

/** A source that can also parse a replay where it is (the app): its timeline, gzipped JSON. And
 * change which folder it lists (the app opens its folder chooser), kept for later runs. */
export interface LocalSource extends ReplaySource {
  timeline(id: string): Promise<Blob>;
  /** A picker card's preview, read from the demo (the server preview's shape; `picker.ts`). */
  preview(id: string): Promise<unknown>;
  chooseFolder(): Promise<"chosen" | "cancelled">;
}

export const isLocal = (s: ReplaySource | undefined): s is LocalSource => typeof (s as LocalSource | undefined)?.timeline === "function";

/** A failed command: its reason code (`not_found`, `brawl`, `old_map`, …). */
export class DesktopError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "DesktopError";
  }
}

const codeOf = (e: unknown) => new DesktopError(typeof e === "string" && /^[a-z_]{1,32}$/.test(e) ? e : "failed");

/** A raw IPC answer as bytes: an ArrayBuffer, a typed array, or (an older IPC path) a number array. */
function bytes(v: unknown): Uint8Array<ArrayBuffer> {
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) as ArrayBuffer);
  if (Array.isArray(v) && v.every((b) => typeof b === "number")) return Uint8Array.from(v as number[]);
  throw new DesktopError("failed");
}

const isReplay = (r: unknown): r is Replay => {
  const o = r as Replay | null;
  return !!o && typeof o.id === "string" && /^[1-9]\d{0,19}$/.test(o.id) && Number.isFinite(o.lastModified) && Number.isFinite(o.size);
};

/** The app's replays folder as a `ReplaySource`, plus the local parse. */
export function desktopSource(invoke: Invoke): LocalSource {
  const call = async (cmd: string, args?: Record<string, unknown>) => {
    try {
      return await invoke(cmd, args);
    } catch (e) {
      throw codeOf(e);
    }
  };
  return {
    list: async () => {
      const v = await call("replays_list");
      if (!Array.isArray(v)) throw new DesktopError("failed");
      return newestFirst(v.filter(isReplay).map((r) => ({ id: r.id, lastModified: r.lastModified, size: r.size })));
    },
    read: async (id) => new File([bytes(await call("replay_read", { id }))], `${id}.dem`, { type: "application/octet-stream" }),
    timeline: async (id) => new Blob([bytes(await call("replay_timeline", { id }))], { type: "application/json" }),
    preview: (id) => call("replay_preview", { id }),
    chooseFolder: async () => ((await call("replays_choose_folder")) === "chosen" ? "chosen" : "cancelled"),
  };
}

// ---- "Get the Windows app" ----

/** The app's release page (the newest published release). */
export const WINDOWS_APP_RELEASES = "https://github.com/intendednull/mapcro/releases/latest";
/** The installer, by its stable name (the release job uploads it beside the versioned one;
 * desktop/README.md, Installer or portable). "Get the Windows app" links here. */
export const WINDOWS_APP_URL = `${WINDOWS_APP_RELEASES}/download/mapcro_x64-setup.exe`;
/** The portable build's zip, by its stable name: the quieter "Portable" beside it. */
export const WINDOWS_APP_PORTABLE_URL = `${WINDOWS_APP_RELEASES}/download/mapcro_x64-portable.zip`;

/**
 * Off until the first release is published, so the site never links to an empty releases page.
 * Turn it on by setting this to `true` (desktop/README.md, Releasing).
 */
export const WINDOWS_APP_RELEASED = false;

type Nav = { userAgent?: string; userAgentData?: { platform?: string } };

/** The download link to show, if any: on a Windows browser, not inside the app, once released. */
export function windowsAppLink(o: { released?: boolean; nav?: Nav; w?: unknown } = {}): string | undefined {
  const released = o.released ?? WINDOWS_APP_RELEASED;
  const nav = o.nav ?? (globalThis.navigator as Nav | undefined);
  if (!released || bridge(o.w ?? globalThis)) return undefined;
  const platform = nav?.userAgentData?.platform;
  const windows = platform ? platform === "Windows" : /\bWindows\b/.test(nav?.userAgent ?? "");
  return windows ? WINDOWS_APP_URL : undefined;
}

/** "Portable", beside "Get the Windows app": shown exactly where it is. */
export function windowsPortableLink(o: Parameters<typeof windowsAppLink>[0] = {}): string | undefined {
  return windowsAppLink(o) ? WINDOWS_APP_PORTABLE_URL : undefined;
}

/**
 * In the portable app: the newer version the update feed offers (the page shows "Update
 * available", a link to the release page). Nothing in a browser, in the installed app (it
 * updates itself), in an app without the command, or on any failure.
 */
export async function appUpdate(invoke: Invoke | undefined = bridge()): Promise<string | undefined> {
  if (!invoke) return undefined;
  try {
    const v = await invoke("app_update");
    return typeof v === "string" && /^[0-9A-Za-z.+-]{1,32}$/.test(v) ? v : undefined;
  } catch {
    return undefined;
  }
}
