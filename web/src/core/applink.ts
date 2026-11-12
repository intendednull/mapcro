// Board links and the app (desktop/README.md, Deep links; spec §6b, The Windows app):
//
// - `mapcro://b/<board>#<token>` is the app's form of a share link (`https://<site>/b/<board>#<token>`,
//   spec §11): the scheme and host swapped, the token still in the fragment. The app's installer
//   registers the scheme; the app maps the link back to the board's page on the site
//   (desktop/core/src/link.rs, the same rules as `parseBoardLink` here).
// - On a board page in a browser, "Open in app" is that link (`openInAppHref`), shown where the
//   app's download is (`desktopAppLinks`: a Windows or desktop Linux browser, never inside the
//   app, once released). The installer, the .deb and the AppImage (at each start) register the scheme.
// - In the app, "Open link" takes a pasted share link or a mapcro:// one (`parseBoardLink`).

import { shareUrl } from "./api";
import { desktopAppLinks } from "../player/desktop";

/** The live site: a pasted https link must be its (or this page's own origin's). */
export const SITE = "https://mapcro.dmgdeadlock.com";
export const SCHEME = "mapcro";
/** The canonical form is 79 characters; longer input isn't a board link. */
const MAX_LEN = 256;
const BOARD_AND_TOKEN = /^([A-Za-z0-9_-]{22})#([A-Za-z0-9_-]{43})$/;

export type BoardLink = { board: string; token: string };

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

/** The app's link to a board. */
export const appLink = (b: BoardLink) => `${SCHEME}://b/${b.board}#${b.token}`;

/** The board's page on this origin. */
export const boardHref = (b: BoardLink, origin: string = location.origin) => shareUrl(origin, b.board, b.token);

/** "Open in app" on a board page: its mapcro:// link, where the app's download shows. */
export function openInAppHref(b: BoardLink, o: Parameters<typeof desktopAppLinks>[0] = {}): string | undefined {
  return desktopAppLinks(o) ? appLink(b) : undefined;
}

/**
 * Open a board in this window. A board page doesn't follow its link changing in place, so a
 * change of fragment only (the same board, another token) reloads (`followHashChanges`).
 */
export function openBoard(b: BoardLink) {
  location.assign(boardHref(b));
}

/**
 * A board page whose fragment changes (another token for the same board: a link opened in the
 * app, an edited address) loads again with it. Nothing in the client sets the fragment.
 */
export function followHashChanges() {
  addEventListener("hashchange", () => {
    if (location.pathname.startsWith("/b/")) location.reload();
  });
}
