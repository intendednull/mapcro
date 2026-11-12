// Board links and the app (core/applink.ts): the pasted link's rules (the same as the app's,
// desktop/core/src/link.rs), the mapcro:// form, and "Open in app"'s gating.
import { describe, expect, it } from "vitest";
import { SITE, appLink, boardHref, openInAppHref, parseBoardLink } from "../src/core/applink";
import { LINUX_APP_URL, WINDOWS_APP_URL, desktopAppLinks } from "../src/player/desktop";

const ID = "AbCdEfGhIjKlMnOpQrSt-_";
const TOKEN = "0123456789abcdefghijklmnopqrstuvwxyzABCD-_Z";
const DEV = "http://127.0.0.1:5173";
const want = { board: ID, token: TOKEN };

describe("parseBoardLink", () => {
  it("takes the site's share link, the mapcro:// form and this page's own origin", () => {
    expect(parseBoardLink(`${SITE}/b/${ID}#${TOKEN}`, DEV)).toEqual(want);
    expect(parseBoardLink(`mapcro://b/${ID}#${TOKEN}`, DEV)).toEqual(want);
    expect(parseBoardLink(`${DEV}/b/${ID}#${TOKEN}`, DEV)).toEqual(want);
    expect(parseBoardLink(`${DEV}/b/${ID}#${TOKEN}`, `${DEV}/`)).toEqual(want);
  });
  it("lets harmless variants through", () => {
    expect(parseBoardLink(`  ${SITE}/b/${ID}#${TOKEN}\n`, DEV)).toEqual(want);
    expect(parseBoardLink(`MAPCRO://B/${ID}#${TOKEN}`, DEV)).toEqual(want);
    expect(parseBoardLink(`HTTPS://Mapcro.DmgDeadlock.com/b/${ID}#${TOKEN}`, DEV)).toEqual(want);
    expect(parseBoardLink(`mapcro://b/${ID}/#${TOKEN}`, DEV)).toEqual(want);
  });
  it("refuses anything else", () => {
    const bad = [
      "",
      "hello",
      "130816395",
      `mapcro://b/${ID}`,
      `mapcro://b/${ID}#`,
      `mapcro://b/${ID}#${TOKEN}x`,
      `mapcro://b/${ID}#${TOKEN.slice(1)}`,
      `mapcro://b/${ID.slice(1)}#${TOKEN}`,
      `mapcro://b/${ID}#${TOKEN.replace("Z", "=")}`,
      `mapcro://b/${ID}#${TOKEN.replace("Z", "/")}`,
      `mapcro://b/${ID}#${TOKEN.replace("Z", "%")}`,
      `mapcro://b/${ID}?x=1#${TOKEN}`,
      `mapcro://b/../${ID}#${TOKEN}`,
      `mapcro://b//${ID}#${TOKEN}`,
      `mapcro://b/${ID}//#${TOKEN}`,
      `mapcro://x/${ID}#${TOKEN}`,
      `mapcro://evil.example/b/${ID}#${TOKEN}`,
      `mapcro://b/${ID}#${TOKEN}#${TOKEN}`,
      `mapcro:b/${ID}#${TOKEN}`,
      `http://mapcro.dmgdeadlock.com/b/${ID}#${TOKEN}`,
      `${SITE}.evil.example/b/${ID}#${TOKEN}`,
      `https://evil.example/b/${ID}#${TOKEN}`,
      `https://user@mapcro.dmgdeadlock.com/b/${ID}#${TOKEN}`,
      `${SITE}:8443/b/${ID}#${TOKEN}`,
      `${SITE}/b/${ID}/#${TOKEN}`,
      `${SITE}/x/b/${ID}#${TOKEN}`,
      `${SITE}/b/${ID}?q#${TOKEN}`,
      `http://127.0.0.2:5173/b/${ID}#${TOKEN}`,
      `javascript:alert(1)//b/${ID}#${TOKEN}`,
      `javascript://b/${ID}#${TOKEN}`,
      `mapcro://b/${ID.replace("_", "é")}#${TOKEN}`,
      `mapcro://b/${ID}#${TOKEN}\u0000`,
      `mapcro://b/${ID} #${TOKEN}`,
      "x".repeat(10_000),
      "mapcro://b/".repeat(40) + `${ID}#${TOKEN}`,
    ];
    for (const s of bad) expect(parseBoardLink(s, DEV), s).toBeUndefined();
  });
});

describe("the mapcro:// form", () => {
  it("is the share link with the scheme and host swapped; the token stays in the fragment", () => {
    expect(appLink(want)).toBe(`mapcro://b/${ID}#${TOKEN}`);
    expect(parseBoardLink(appLink(want), DEV)).toEqual(want);
    expect(boardHref(want, DEV)).toBe(`${DEV}/b/${ID}#${TOKEN}`);
  });
});

describe("openInAppHref", () => {
  const win = { userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/142 Safari/537.36" };
  const linux = { userAgent: "Mozilla/5.0 (X11; Linux x86_64) Chrome/142" };
  const mac = { userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1.15" };
  it("is the board's mapcro:// link on a Windows or desktop Linux browser, once the app is released", () => {
    expect(openInAppHref(want, { released: true, nav: win, w: {} })).toBe(`mapcro://b/${ID}#${TOKEN}`);
    expect(openInAppHref(want, { released: true, nav: linux, w: {} })).toBe(`mapcro://b/${ID}#${TOKEN}`);
    // Its "Get the app" fallback is that system's default download, under the same gate.
    expect(desktopAppLinks({ released: true, nav: win, w: {} })?.href).toBe(WINDOWS_APP_URL);
    expect(desktopAppLinks({ released: true, nav: linux, w: {} })?.href).toBe(LINUX_APP_URL);
  });
  it("is nothing before the release, elsewhere, or inside the app", () => {
    expect(openInAppHref(want, { released: false, nav: win, w: {} })).toBeUndefined();
    expect(openInAppHref(want, { released: true, nav: mac, w: {} })).toBeUndefined();
    expect(openInAppHref(want, { released: true, nav: win, w: { __TAURI_INTERNALS__: { invoke: () => Promise.resolve() } } })).toBeUndefined();
  });
});
