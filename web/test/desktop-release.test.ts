// The app's download (desktop/README.md, Releasing): per system, the one build that updates itself
// (operator, 2026-11-11: a browser gets no portable zip or .deb link), a file of the latest release by the stable
// name the release jobs upload (never a release page); shown on Windows and desktop Linux
// browsers only, never in the app, under DESKTOP_APP_RELEASED. And the app's "Update available"
// (`appUpdate`; desktop/README.md, Updates): the installed app's banner, Install only on a click
// (`updatePrompt`, issue #43), and the portable app's link.
import { describe, expect, it } from "vitest";
import {
  DESKTOP_APP_RELEASED,
  type Invoke,
  LINUX_APP_URL,
  WINDOWS_APP_PORTABLE_URL,
  WINDOWS_APP_URL,
  LATER_KEY,
  type PromptState,
  appUpdate,
  desktopAppLinks,
  installUpdate,
  updatePrompt,
  desktopOs,
} from "../src/player/desktop";
import { openInAppHref } from "../src/core/applink";

const UA = {
  windows: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
  windowsFirefox: "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0",
  linuxChrome: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
  linuxFirefox: "Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0",
  linuxArm: "Mozilla/5.0 (X11; Linux aarch64; rv:133.0) Gecko/20100101 Firefox/133.0",
  android: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36",
  androidFirefox: "Mozilla/5.0 (Android 14; Mobile; rv:133.0) Gecko/133.0 Firefox/133.0",
  chromeOs: "Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
  macOs: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
  iPhone: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
  iPad: "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
  windowsPhone: "Mozilla/5.0 (Windows Phone 10.0; Android 6.0.1; Microsoft; Lumia 950) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/52.0 Mobile Safari/537.36 Edge/15.15063",
};
const inApp = { __TAURI_INTERNALS__: { invoke: () => Promise.resolve() } };
const at = (userAgent: string, platform?: string) => ({ released: true, nav: platform ? { userAgent, userAgentData: { platform } } : { userAgent }, w: {} });

describe("the download files", () => {
  it("are files of the latest release by stable names, never a release page", () => {
    const base = "https://github.com/intendednull/mapcro/releases/latest/download/";
    expect(WINDOWS_APP_URL).toBe(`${base}mapcro_x64-setup.exe`);
    expect(LINUX_APP_URL).toBe(`${base}mapcro_amd64.AppImage`);
    // The portable app's Update available only.
    expect(WINDOWS_APP_PORTABLE_URL).toBe(`${base}mapcro_x64-portable.zip`);
  });
  it("are on: the first releases are out (operator, 2026-11-11)", () => {
    expect(DESKTOP_APP_RELEASED).toBe(true);
  });
});

describe("desktopAppLinks: the system matrix", () => {
  it("Windows: the installer only", () => {
    for (const o of [at(UA.windows), at(UA.windowsFirefox), at(UA.windows, "Windows"), at(UA.macOs, "Windows")]) {
      expect(desktopAppLinks(o)).toEqual({
        os: "windows",
        label: "Get the Windows app",
        title: "Windows app",
        href: WINDOWS_APP_URL,
      });
    }
  });
  it("desktop Linux: the AppImage only", () => {
    for (const o of [at(UA.linuxChrome), at(UA.linuxFirefox), at(UA.linuxChrome, "Linux")]) {
      expect(desktopAppLinks(o)).toEqual({
        os: "linux",
        label: "Get the Linux app",
        title: "Linux app",
        href: LINUX_APP_URL,
      });
    }
  });
  it("nothing on Android, ChromeOS, ARM Linux, macOS, iPhone, iPad or Windows Phone", () => {
    const none = [
      at(UA.android),
      at(UA.android, "Android"),
      at(UA.androidFirefox),
      at(UA.chromeOs),
      at(UA.chromeOs, "Chrome OS"),
      at(UA.linuxArm),
      at(UA.macOs),
      at(UA.macOs, "macOS"),
      at(UA.windows, "macOS"),
      at(UA.iPhone),
      at(UA.iPad),
      at(UA.windowsPhone),
      at(""),
    ];
    for (const o of none) expect(desktopAppLinks(o), o.nav.userAgent).toBeUndefined();
  });
  it("nothing inside the app, on either system", () => {
    for (const ua of [UA.windows, UA.linuxChrome]) expect(desktopAppLinks({ ...at(ua), w: inApp })).toBeUndefined();
  });
  it("nothing anywhere while the flag is off", () => {
    for (const ua of [UA.windows, UA.linuxChrome]) expect(desktopAppLinks({ ...at(ua), released: false })).toBeUndefined();
  });
  it("desktopOs reads the same matrix", () => {
    expect(desktopOs({ userAgent: UA.windows })).toBe("windows");
    expect(desktopOs({ userAgent: UA.linuxFirefox })).toBe("linux");
    for (const ua of [UA.android, UA.chromeOs, UA.macOs, UA.iPhone, UA.linuxArm]) expect(desktopOs({ userAgent: ua }), ua).toBeUndefined();
    expect(desktopOs(undefined)).toBeUndefined();
  });
});

describe("Open in app follows the same rule", () => {
  const b = { board: "AbCdEfGhIjKlMnOpQrSt-_", token: "0123456789abcdefghijklmnopqrstuvwxyzABCD-_Z" };
  it("is the mapcro:// link exactly where a download shows", () => {
    for (const ua of Object.values(UA)) {
      for (const o of [at(ua), { ...at(ua), w: inApp }, { ...at(ua), released: false }]) {
        expect(openInAppHref(b, o), ua).toBe(desktopAppLinks(o) ? `mapcro://b/${b.board}#${b.token}` : undefined);
      }
    }
    expect(openInAppHref(b, at(UA.linuxChrome))).toBe(`mapcro://b/${b.board}#${b.token}`);
    expect(openInAppHref(b, at(UA.windows))).toBe(`mapcro://b/${b.board}#${b.token}`);
    expect(openInAppHref(b, at(UA.macOs))).toBeUndefined();
  });
});

describe("appUpdate", () => {
  const answering = (v: unknown): Invoke => async (cmd) => {
    if (cmd !== "app_update") throw "unknown_command";
    return v;
  };
  it("is the version the app reports, and how to offer it", async () => {
    expect(await appUpdate(answering({ version: "0.2.3", kind: "install" }))).toEqual({ version: "0.2.3", kind: "install" });
    expect(await appUpdate(answering({ version: "0.2.3", kind: "link" }))).toEqual({ version: "0.2.3", kind: "link" });
  });
  it("takes an app before 0.2.2's bare version as the portable link (only portable answered one)", async () => {
    expect(await appUpdate(answering("0.2.0"))).toEqual({ version: "0.2.0", kind: "link" });
  });
  it("is nothing when up to date, in a browser, in an older app, or on a strange answer", async () => {
    expect(await appUpdate(answering(null))).toBeUndefined();
    expect(await appUpdate(undefined)).toBeUndefined();
    expect(await appUpdate(async () => Promise.reject("unknown_command"))).toBeUndefined();
    expect(await appUpdate(answering(2))).toBeUndefined();
    expect(await appUpdate(answering("<b>1</b>"))).toBeUndefined();
    expect(await appUpdate(answering("x".repeat(100)))).toBeUndefined();
    expect(await appUpdate(answering({ version: "<b>1</b>", kind: "install" }))).toBeUndefined();
    expect(await appUpdate(answering({ version: "0.2.3", kind: "run" }))).toBeUndefined();
    expect(await appUpdate(answering({ kind: "install" }))).toBeUndefined();
  });
});

/** A stand-in for the app with an update out: records every command, and answers Install as
 * `install` says (never settling is the app restarting). */
function updatingApp(o: { offer?: unknown; install?: () => Promise<unknown> } = {}) {
  const calls: [string, Record<string, unknown> | undefined][] = [];
  const invoke: Invoke = async (cmd, args) => {
    calls.push([cmd, args]);
    if (cmd === "app_update") return "offer" in o ? o.offer : { version: "0.2.3", kind: "install" };
    if (cmd === "app_update_install") return (o.install ?? (() => new Promise(() => {})))();
    throw "unknown_command";
  };
  return { invoke, calls };
}

/** sessionStorage's two calls, on a Map. */
function memory() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("updatePrompt (the installed app's banner)", () => {
  it("shows the offer and installs nothing without a click", async () => {
    const { invoke, calls } = updatingApp();
    const states: PromptState[] = [];
    const p = updatePrompt((s) => states.push(s), { invoke, storage: memory() });
    await p.start();
    await flush();
    expect(states).toEqual([{ kind: "offer", version: "0.2.3" }]);
    expect(calls.map(([c]) => c)).toEqual(["app_update"]);
  });

  it("installs the offered version on Install, and says so until the app restarts", async () => {
    const { invoke, calls } = updatingApp();
    const states: PromptState[] = [];
    const p = updatePrompt((s) => states.push(s), { invoke, storage: memory() });
    await p.start();
    void p.install();
    await flush();
    expect(calls).toEqual([["app_update", undefined], ["app_update_install", { version: "0.2.3" }]]);
    expect(states.at(-1)).toEqual({ kind: "installing", version: "0.2.3" });
  });

  it("says Update failed when the install fails, and Retry asks again", async () => {
    let fail = true;
    const { invoke, calls } = updatingApp({ install: () => (fail ? Promise.reject("failed") : new Promise(() => {})) });
    const states: PromptState[] = [];
    const p = updatePrompt((s) => states.push(s), { invoke, storage: memory() });
    await p.start();
    await p.install();
    expect(states.slice(-2)).toEqual([{ kind: "installing", version: "0.2.3" }, { kind: "failed", version: "0.2.3" }]);
    fail = false;
    void p.install();
    await flush();
    expect(states.at(-1)).toEqual({ kind: "installing", version: "0.2.3" });
    expect(calls.filter(([c]) => c === "app_update_install")).toHaveLength(2);
  });

  it("Later hides it for this run, for that version only", async () => {
    const storage = memory();
    const first = updatingApp();
    const states: PromptState[] = [];
    const p = updatePrompt((s) => states.push(s), { invoke: first.invoke, storage });
    await p.start();
    p.later();
    expect(states.at(-1)).toEqual({ kind: "hidden" });
    expect(storage.m.get(LATER_KEY)).toBe("0.2.3");
    expect(first.calls.map(([c]) => c)).toEqual(["app_update"]);

    // The next page load in this run (another board, a reload): still hidden.
    const again: PromptState[] = [];
    await updatePrompt((s) => again.push(s), { invoke: updatingApp().invoke, storage }).start();
    expect(again).toEqual([]);

    // A newer version than the one put off shows again.
    const newer: PromptState[] = [];
    await updatePrompt((s) => newer.push(s), { invoke: updatingApp({ offer: { version: "0.2.4", kind: "install" } }).invoke, storage }).start();
    expect(newer).toEqual([{ kind: "offer", version: "0.2.4" }]);
  });

  it("shows nothing in a browser, when up to date, in the portable app (its link instead) or an older app", async () => {
    for (const offer of [null, { version: "0.2.3", kind: "link" }, "0.2.3", undefined]) {
      const states: PromptState[] = [];
      const { invoke, calls } = updatingApp({ offer });
      const p = updatePrompt((s) => states.push(s), { invoke, storage: memory() });
      await p.start();
      await p.install();
      expect(states, JSON.stringify(offer)).toEqual([]);
      expect(calls.map(([c]) => c)).toEqual(["app_update"]);
    }
    const states: PromptState[] = [];
    const p = updatePrompt((s) => states.push(s), { invoke: undefined, storage: memory() });
    await p.start();
    await p.install();
    expect(states).toEqual([]);
  });
});

describe("installUpdate", () => {
  it("names the version and passes the app's reason on", async () => {
    const { invoke, calls } = updatingApp({ install: () => Promise.reject("no_update") });
    await expect(installUpdate("0.2.3", invoke)).rejects.toMatchObject({ code: "no_update" });
    await expect(installUpdate("0.2.3", async () => Promise.reject({ weird: 1 }))).rejects.toMatchObject({ code: "failed" });
    await expect(installUpdate("0.2.3", undefined)).rejects.toMatchObject({ code: "failed" });
    expect(calls).toEqual([["app_update_install", { version: "0.2.3" }]]);
  });
});
