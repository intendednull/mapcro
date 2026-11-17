// Board links and the app (desktop/README.md, Deep links; spec §6b, The Windows app):
//
// - `mapcro://b/<board>#<token>` is the app's form of a share link (`https://<site>/b/<board>#<token>`,
//   spec §11): the scheme and host swapped, the token still in the fragment. The app's installer
//   registers the scheme; the app maps the link back to the board's page on the site
//   (desktop/core/src/link.rs, the same rules as `parseBoardLink` here).
// - On a board page in a browser, "Open in app" is that link (`openInAppHref`), shown where the
//   app's download is (`desktopAppLinks`: a Windows or desktop Linux browser, never inside the
//   app, once released). The installer and the AppImage (at each start) register the scheme; the .deb too.
// - In the app, "Open link" takes a pasted share link or a mapcro:// one (`parseBoardLink`).
// - A session's link has the same two forms (sessions.md §7.1): `mapcro://s/<session>#<token>`,
//   or with the tab it names, `mapcro://s/<session>?tab=<tab>#<token>`, and the site's
//   `https://<site>/s/<session>?tab=<tab>#<token>` (`parseLink`). A session's page offers it as
//   its "Open in app".

import { sessionUrl, shareUrl } from "./api";
import { desktopAppLinks } from "../player/desktop";

/** The live site: a pasted https link must be its (or this page's own origin's). */
export const SITE = "https://mapcro.dmgdeadlock.com";
export const SCHEME = "mapcro";
/** The canonical form is 79 characters; longer input isn't a board link. */
const MAX_LEN = 256;
const BOARD_AND_TOKEN = /^([A-Za-z0-9_-]{22})#([A-Za-z0-9_-]{43})$/;
/** A session's id, an optional tab (a record id: 32 lowercase hex digits), and its token. */
const SESSION_AND_TOKEN = /^([A-Za-z0-9_-]{22})(?:\?tab=([0-9a-f]{32}))?#([A-Za-z0-9_-]{43})$/;

export type BoardLink = { board: string; token: string };
export type SessionLink = { session: string; token: string; tab?: string };
/** What a pasted or app link names: a board, or a session (and maybe its tab). */
export type Link = ({ kind: "board" } & BoardLink) | ({ kind: "session" } & SessionLink);

/** `rest` starts with `prefix`, ignoring ASCII case: what follows it. */
const after = (rest: string, prefix: string) => (rest.slice(0, prefix.length).toLowerCase() === prefix.toLowerCase() ? rest.slice(prefix.length) : undefined);

function boardAndToken(rest: string | undefined, trailingSlash: boolean): BoardLink | undefined {
  if (rest === undefined) return undefined;
  const m = BOARD_AND_TOKEN.exec(trailingSlash ? rest.replace(/^([^#/]*)\/#/, "$1#") : rest);
  return m ? { board: m[1]!, token: m[2]! } : undefined;
}

/**
 * The board a pasted link names: `mapcro://b/<board>#<token>` (a `/` after the board id allowed),
 * or a share link on the site, `https://mapcro.dmgdeadlock.com/b/<board>#<token>` (or on this
 * page's own origin: a dev server). Anything else, nothing. Whitespace around it is dropped; the
 * scheme and host have no case.
 */
export function parseBoardLink(input: string, origin: string = location.origin): BoardLink | undefined {
  const s = input.trim();
  if (s.length > MAX_LEN || !/^[\x21-\x7e]*$/.test(s)) return undefined;
  const app = after(s, `${SCHEME}://b/`);
  if (app !== undefined) return boardAndToken(app, true);
  for (const o of new Set([SITE, origin.replace(/\/$/, "")])) {
    const rest = after(s, `${o}/b/`);
    if (rest !== undefined) return boardAndToken(rest, false);
  }
  return undefined;
}

function sessionAndToken(rest: string | undefined, trailingSlash: boolean): SessionLink | undefined {
  if (rest === undefined) return undefined;
  const m = SESSION_AND_TOKEN.exec(trailingSlash ? rest.replace(/^([^#/?]*)\/([?#])/, "$1$2") : rest);
  return m ? { session: m[1]!, token: m[3]!, ...(m[2] ? { tab: m[2] } : {}) } : undefined;
}

/**
 * The board or session a pasted link names: a board's (`parseBoardLink`), or a session's in the
 * same two forms, `mapcro://s/<session>[?tab=<tab>]#<token>` (a `/` after the session id
 * allowed) or `https://<site>/s/<session>[?tab=<tab>]#<token>` (or this page's own origin).
 * `tab` is the only query a session's link may have. Anything else, nothing.
 */
export function parseLink(input: string, origin: string = location.origin): Link | undefined {
  const b = parseBoardLink(input, origin);
  if (b) return { kind: "board", ...b };
  const s = input.trim();
  if (s.length > MAX_LEN || !/^[\x21-\x7e]*$/.test(s)) return undefined;
  const app = after(s, `${SCHEME}://s/`);
  const found =
    app !== undefined
      ? sessionAndToken(app, true)
      : [...new Set([SITE, origin.replace(/\/$/, "")])].map((o) => sessionAndToken(after(s, `${o}/s/`), false)).find((x) => x !== undefined);
  return found ? { kind: "session", ...found } : undefined;
}

/** The app's link to a session, naming its tab when given. */
export const sessionAppLink = (l: SessionLink) => `${SCHEME}://s/${l.session}${l.tab ? `?tab=${l.tab}` : ""}#${l.token}`;

/** The app's link to a board. */
export const appLink = (b: BoardLink) => `${SCHEME}://b/${b.board}#${b.token}`;

/** The board's page on this origin. */
export const boardHref = (b: BoardLink, origin: string = location.origin) => shareUrl(origin, b.board, b.token);

/** "Open in app" on a board page: its mapcro:// link, where the app's download shows. */
export function openInAppHref(b: BoardLink, o: Parameters<typeof desktopAppLinks>[0] = {}): string | undefined {
  return desktopAppLinks(o) ? appLink(b) : undefined;
}

/** "Open in app" on a session's page: its mapcro:// link, where the app's download shows. */
/** The released desktop app opens `mapcro://s/` links. Off until a desktop release with the
 * session parser has been out a while: an older app ignores them (TD-117). Until then a session's
 * tab offers the board's own link, as before phase 5. */
export const APP_OPENS_SESSIONS = false;

export function openSessionInAppHref(l: SessionLink, o: Parameters<typeof desktopAppLinks>[0] = {}): string | undefined {
  return desktopAppLinks(o) ? sessionAppLink(l) : undefined;
}

/** A link's page on this origin. Opened with `location.assign`: a change of fragment only (the
 * same board, another token) is followed in place, and the board mounts again with the new token
 * (core/nav.ts). */
export const linkHref = (l: Link, origin: string = location.origin) => (l.kind === "board" ? boardHref(l, origin) : sessionUrl(origin, l.session, l.token, l.tab));
