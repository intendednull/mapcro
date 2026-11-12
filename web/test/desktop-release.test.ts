// The app's two Windows downloads (desktop/README.md, Installer or portable): the installer by
// default, "Portable" beside it, both by the stable names the release job uploads, both under
// WINDOWS_APP_RELEASED; and the portable app's "Update available" (`appUpdate`).
import { describe, expect, it } from "vitest";
import { type Invoke, WINDOWS_APP_PORTABLE_URL, WINDOWS_APP_RELEASES, WINDOWS_APP_URL, appUpdate, windowsAppLink, windowsPortableLink } from "../src/player/desktop";

const win = { userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/142 Safari/537.36" };
const linux = { userAgent: "Mozilla/5.0 (X11; Linux x86_64) Chrome/142" };
const inApp = { __TAURI_INTERNALS__: { invoke: () => Promise.resolve() } };

describe("the download links", () => {
  it("point at the latest release's assets by stable names: the installer, and the portable zip", () => {
    expect(WINDOWS_APP_RELEASES).toBe("https://github.com/intendednull/mapcro/releases/latest");
    expect(WINDOWS_APP_URL).toBe("https://github.com/intendednull/mapcro/releases/latest/download/mapcro_x64-setup.exe");
    expect(WINDOWS_APP_PORTABLE_URL).toBe("https://github.com/intendednull/mapcro/releases/latest/download/mapcro_x64-portable.zip");
    expect(windowsAppLink({ released: true, nav: win, w: {} })).toBe(WINDOWS_APP_URL);
    expect(windowsPortableLink({ released: true, nav: win, w: {} })).toBe(WINDOWS_APP_PORTABLE_URL);
  });
  it("Portable shows exactly where the installer's link does", () => {
    for (const o of [{ released: false, nav: win, w: {} }, { released: true, nav: linux, w: {} }, { released: true, nav: win, w: inApp }]) {
      expect(windowsAppLink(o)).toBeUndefined();
      expect(windowsPortableLink(o)).toBeUndefined();
    }
  });
});

describe("appUpdate", () => {
  const answering = (v: unknown): Invoke => async (cmd) => {
    if (cmd !== "app_update") throw "unknown_command";
    return v;
  };
  it("is the version the portable app reports", async () => {
    expect(await appUpdate(answering("0.2.0"))).toBe("0.2.0");
  });
  it("is nothing when up to date, installed, in a browser, in an older app, or on a strange answer", async () => {
    expect(await appUpdate(answering(null))).toBeUndefined();
    expect(await appUpdate(undefined)).toBeUndefined();
    expect(await appUpdate(async () => Promise.reject("unknown_command"))).toBeUndefined();
    expect(await appUpdate(answering(2))).toBeUndefined();
    expect(await appUpdate(answering("<b>1</b>"))).toBeUndefined();
    expect(await appUpdate(answering("x".repeat(100)))).toBeUndefined();
  });
});
