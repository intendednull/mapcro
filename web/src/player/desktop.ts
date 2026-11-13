// The Windows app's bridge (desktop/README.md): the same site, in the app's window, with eight
// commands to the native side: list the replays folder, read one replay, preview one (read from
// its demo here), parse one here, change the folder (the system's folder chooser), save a board
// where the user says (the Save as dialog), ask whether an update is out, and install it on the
// user's click. The page passes only match ids and a board's suggested name, never paths,
// and the app grants the commands to this site's origin only. Feature-detected: in a browser none of this exists, and nothing changes.
//
// Also the download links for the app (`desktopAppLinks`), shown on Windows and desktop Linux
// browsers only, and the app's update notice (`appUpdate`): the installed app's banner with
// Install (`updatePrompt`), the portable app's link to the new zip.

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

// ---- "Get the Windows app" / "Get the Linux app" ----

/** The repository's releases; every download is a file of the newest published one, by the
 * stable name the release job uploads beside the versioned one (desktop/README.md, Releasing).
 * A download link always names a file, never a release page (operator, 2026-11-11). */
const LATEST = "https://github.com/intendednull/mapcro/releases/latest/download";
/** A browser is offered only the builds that update themselves (operator, 2026-11-11). Releases
 * still carry the portable zip and the .deb; only the portable app itself links its zip. */
/** The Windows installer: "Get the Windows app". */
export const WINDOWS_APP_URL = `${LATEST}/mapcro_x64-setup.exe`;
/** The portable build's zip: the portable app's "Update available" only, never a browser's link. */
export const WINDOWS_APP_PORTABLE_URL = `${LATEST}/mapcro_x64-portable.zip`;
/** The AppImage: "Get the Linux app". */
export const LINUX_APP_URL = `${LATEST}/mapcro_amd64.AppImage`;

/**
 * One flag for both platforms: every tagged release builds both, and its `publish` job refuses a
 * draft that lacks either platform's files, so one can't be out without the other. Off would
 * hide every download link and "Open in app" (desktop/README.md, Releasing).
 */
export const DESKTOP_APP_RELEASED = true;

export type DesktopOs = "windows" | "linux";
type Nav = { userAgent?: string; userAgentData?: { platform?: string } };

/**
 * The system a build is offered for: Windows, or desktop Linux on x86-64. Not Android (its user
 * agent says Linux too), ChromeOS (its user agent says CrOS, its client hints "Chrome OS"), nor
 * an ARM Linux (Firefox names the CPU; the builds are x86-64 only). Anything else (macOS, phones)
 * is none. The client-hints platform wins where the browser has it (Chromium; its Linux user
 * agent always says x86_64).
 */
export function desktopOs(nav: Nav | undefined): DesktopOs | undefined {
  const platform = nav?.userAgentData?.platform;
  const ua = nav?.userAgent ?? "";
  if (platform) return platform === "Windows" ? "windows" : platform === "Linux" ? "linux" : undefined;
  if (/\bWindows\b/.test(ua) && !/\bWindows Phone\b/.test(ua)) return "windows";
  if (/\bLinux\b/.test(ua) && !/\bAndroid\b/.test(ua) && !/\b(aarch64|arm64|armv\d+l?)\b/i.test(ua)) return "linux";
  return undefined;
}

/** A system's download: one link, the self-updating build. */
export type DesktopLinks = { os: DesktopOs; label: string; title: string; href: string };

const LINKS: Record<DesktopOs, DesktopLinks> = {
  windows: { os: "windows", label: "Get the Windows app", title: "Windows app", href: WINDOWS_APP_URL },
  linux: { os: "linux", label: "Get the Linux app", title: "Linux app", href: LINUX_APP_URL },
};

/** The app's downloads to show, if any: on a Windows or desktop Linux browser, never inside the
 * app, once released. Every placement (and "Open in app") shows exactly when this is something. */
export function desktopAppLinks(o: { released?: boolean; nav?: Nav; w?: unknown } = {}): DesktopLinks | undefined {
  const released = o.released ?? DESKTOP_APP_RELEASED;
  if (!released || bridge(o.w ?? globalThis)) return undefined;
  const os = desktopOs(o.nav ?? (globalThis.navigator as Nav | undefined));
  return os ? LINKS[os] : undefined;
}

/** A newer version of the app, and how the page offers it: `install` (the installer, the
 * AppImage: "Update available" with Install and Later) or `link` (portable: a link to the new zip). */
export type AppUpdate = { version: string; kind: "install" | "link" };

const VERSION = /^[0-9A-Za-z.+-]{1,32}$/;

/**
 * In the app: the newer version the update feed offers, if any (desktop/README.md, Updates).
 * Nothing in a browser, when up to date, for a .deb (its package manager updates it), in an app
 * without the command, or on any failure. An app before 0.2.2 answers a bare version, and only
 * the portable one answers at all (the installed one installed by itself): that's a link.
 */
export async function appUpdate(invoke: Invoke | undefined = bridge()): Promise<AppUpdate | undefined> {
  if (!invoke) return undefined;
  try {
    const v = await invoke("app_update");
    if (typeof v === "string") return VERSION.test(v) ? { version: v, kind: "link" } : undefined;
    const o = v as Partial<AppUpdate> | null;
    if (!o || typeof o.version !== "string" || !VERSION.test(o.version)) return undefined;
    return o.kind === "install" || o.kind === "link" ? { version: o.version, kind: o.kind } : undefined;
  } catch {
    return undefined;
  }
}

/** Install, clicked: the app downloads and installs `version` (the one `appUpdate` gave), then
 * restarts, so on success this never settles. Rejects with a `DesktopError` (`failed`, `busy`,
 * `no_update`). Only ever on the user's click. */
export async function installUpdate(version: string, invoke: Invoke | undefined = bridge()): Promise<void> {
  if (!invoke) throw new DesktopError("failed");
  try {
    await invoke("app_update_install", { version });
  } catch (e) {
    throw codeOf(e);
  }
}

/** The update banner's states: nothing to show, the offer, Install under way, Install failed. */
export type PromptState = { kind: "hidden" } | { kind: "offer" | "installing" | "failed"; version: string };

/** Where Later is kept: this run's session (the window's sessionStorage, which a page load in
 * the app keeps and quitting the app drops), by version. */
export const LATER_KEY = "mapcro.update-later";
type Session = Pick<Storage, "getItem" | "setItem">;

const session = (): Session | undefined => {
  try {
    return globalThis.sessionStorage;
  } catch {
    return undefined;
  }
};

/**
 * The installed app's "Update available" banner (operator, 2026-11-11, issue #43): shown when the
 * app offers Install for a newer version, unless Later was clicked for it this run. `install`
 * asks the app to install (it restarts on success; "Update failed" with Retry otherwise), `later`
 * hides it for this run. Nothing happens without a click: `start` only asks whether there is one.
 */
export function updatePrompt(set: (s: PromptState) => void, o: { invoke?: Invoke | undefined; storage?: Session | undefined } = {}) {
  const invoke = "invoke" in o ? o.invoke : bridge();
  const storage = "storage" in o ? o.storage : session();
  let version: string | undefined;
  return {
    async start() {
      const u = await appUpdate(invoke);
      if (!u || u.kind !== "install" || storage?.getItem(LATER_KEY) === u.version) return;
      version = u.version;
      set({ kind: "offer", version });
    },
    async install() {
      if (!version) return;
      set({ kind: "installing", version });
      try {
        await installUpdate(version, invoke);
      } catch {
        set({ kind: "failed", version });
      }
    },
    later() {
      if (version) storage?.setItem(LATER_KEY, version);
      set({ kind: "hidden" });
    },
  };
}
