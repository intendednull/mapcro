// Board links and the app (core/applink.ts): the pasted link's rules (the same as the app's,
// desktop/core/src/link.rs), the mapcro:// form, and "Open in app"'s gating.
import { describe, expect, it } from "vitest";
import { SITE, appLink, boardHref, linkHref, openInAppHref, openSessionInAppHref, parseBoardLink, parseLink, sessionAppLink } from "../src/core/applink";
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

describe("a session's link (sessions.md §7.1)", () => {
  const TAB = "0123456789abcdef0123456789abcdef";
  const s = { kind: "session", session: ID, token: TOKEN } as const;
  it("takes the mapcro:// form and the site's, with or without the tab it names", () => {
    expect(parseLink(`mapcro://s/${ID}#${TOKEN}`, DEV)).toEqual(s);
    expect(parseLink(`mapcro://s/${ID}?tab=${TAB}#${TOKEN}`, DEV)).toEqual({ ...s, tab: TAB });
    expect(parseLink(`${SITE}/s/${ID}?tab=${TAB}#${TOKEN}`, DEV)).toEqual({ ...s, tab: TAB });
    expect(parseLink(`${SITE}/s/${ID}#${TOKEN}`, DEV)).toEqual(s);
    expect(parseLink(`${DEV}/s/${ID}?tab=${TAB}#${TOKEN}`, DEV)).toEqual({ ...s, tab: TAB });
    // Harmless variants, as a board's link has them.
    expect(parseLink(`  MAPCRO://S/${ID}#${TOKEN}\n`, DEV)).toEqual(s);
    expect(parseLink(`mapcro://s/${ID}/#${TOKEN}`, DEV)).toEqual(s);
    expect(parseLink(`mapcro://s/${ID}/?tab=${TAB}#${TOKEN}`, DEV)).toEqual({ ...s, tab: TAB });
    // A board's link is still a board's.
    expect(parseLink(`mapcro://b/${ID}#${TOKEN}`, DEV)).toEqual({ kind: "board", ...want });
  });
  it("is no board link: Paste link (a board for the session) refuses it", () => {
    expect(parseBoardLink(`mapcro://s/${ID}#${TOKEN}`, DEV)).toBeUndefined();
    expect(parseBoardLink(`${SITE}/s/${ID}?tab=${TAB}#${TOKEN}`, DEV)).toBeUndefined();
  });
  it("refuses anything else", () => {
    const bad = [
      `mapcro://s/${ID}`,
      `mapcro://s/${ID}#`,
      `mapcro://s/${ID}#${TOKEN}x`,
      `mapcro://s/${ID.slice(1)}#${TOKEN}`,
      `mapcro://s/${ID}?tab=${TAB.toUpperCase()}#${TOKEN}`, // a record id is lowercase
      `mapcro://s/${ID}?tab=${TAB.slice(1)}#${TOKEN}`,
      `mapcro://s/${ID}?tab=${TAB}0#${TOKEN}`,
      `mapcro://s/${ID}?tab=#${TOKEN}`,
      `mapcro://s/${ID}?x=1#${TOKEN}`, // tab is the only query
      `mapcro://s/${ID}?tab=${TAB}&x=1#${TOKEN}`,
      `mapcro://s/${ID}?tab=${TAB}/#${TOKEN}`,
      `mapcro://s/${ID}//#${TOKEN}`,
      `mapcro://s//${ID}#${TOKEN}`,
      `mapcro://s/../${ID}#${TOKEN}`,
      `mapcro://evil.example/s/${ID}#${TOKEN}`,
      `${SITE}/s/${ID}/#${TOKEN}`, // the site's links have no slash
      `${SITE}/s/${ID}/?tab=${TAB}#${TOKEN}`,
      `https://evil.example/s/${ID}#${TOKEN}`,
      `http://mapcro.dmgdeadlock.com/s/${ID}#${TOKEN}`,
      `${SITE}.evil.example/s/${ID}#${TOKEN}`,
      `mapcro://s/${ID}#${TOKEN}\u0000`,
      "mapcro://s/".repeat(40) + `${ID}#${TOKEN}`,
    ];
    for (const x of bad) expect(parseLink(x, DEV), x).toBeUndefined();
  });
  it("the mapcro:// form names the tab; the page on this origin is the session's address", () => {
    expect(sessionAppLink({ session: ID, token: TOKEN, tab: TAB })).toBe(`mapcro://s/${ID}?tab=${TAB}#${TOKEN}`);
    expect(sessionAppLink({ session: ID, token: TOKEN })).toBe(`mapcro://s/${ID}#${TOKEN}`);
    expect(parseLink(sessionAppLink({ session: ID, token: TOKEN, tab: TAB }), DEV)).toEqual({ ...s, tab: TAB });
    expect(linkHref({ ...s, tab: TAB }, DEV)).toBe(`${DEV}/s/${ID}?tab=${TAB}#${TOKEN}`);
    expect(linkHref({ kind: "board", ...want }, DEV)).toBe(`${DEV}/b/${ID}#${TOKEN}`);
  });
  it("is a session page's Open in app, gated as a board's", () => {
    const win = { userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/142" };
    expect(openSessionInAppHref({ session: ID, token: TOKEN, tab: TAB }, { released: true, nav: win, w: {} })).toBe(`mapcro://s/${ID}?tab=${TAB}#${TOKEN}`);
    expect(openSessionInAppHref({ session: ID, token: TOKEN }, { released: false, nav: win, w: {} })).toBeUndefined();
  });
});
